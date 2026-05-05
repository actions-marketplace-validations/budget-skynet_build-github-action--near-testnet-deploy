async function jsonRpc(rpcUrl, method, params) {
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  };

  const resp = await httpRequest(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, payload);

  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`RPC HTTP error ${resp.statusCode}: ${resp.body}`);
  }

  const parsed = JSON.parse(resp.body);
  if (parsed.error) {
    throw new Error(`RPC error [${parsed.error.code}]: ${parsed.error.message} — ${JSON.stringify(parsed.error.data)}`);
  }
  return parsed.result;
}

// ─── NEAR helpers ────────────────────────────────────────────────────────────

function resolveRpcUrl(network) {
  if (network === 'testnet') return 'https://rpc.testnet.near.org';
  if (network === 'mainnet') return 'https://rpc.mainnet.near.org';
  // Allow custom RPC URL
  if (network.startsWith('http')) return network;
  return 'https://rpc.testnet.near.org';
}

async function accountExists(rpcUrl, accountId) {
  try {
    await jsonRpc(rpcUrl, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return true;
  } catch (err) {
    if (err.message.includes('does not exist') || err.message.includes('UNKNOWN_ACCOUNT')) {
      return false;
    }
    throw err;
  }
}

async function getAccountBalance(rpcUrl, accountId) {
  const result = await jsonRpc(rpcUrl, 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  });
  // amount is in yoctoNEAR (10^24)
  const yocto = BigInt(result.amount);
  const near = Number(yocto) / 1e24;
  return { yocto, near };
}

function nearToYocto(amount) {
  // Multiply by 10^24 — use string math to avoid float precision issues
  const parts = String(amount).split('.');
  const whole = BigInt(parts[0]) * BigInt('1000000000000000000000000');
  if (parts[1]) {
    const frac = parts[1].slice(0, 24).padEnd(24, '0');
    return whole + BigInt(frac);
  }
  return whole;
}

// ─── NEAR CLI wrapper ────────────────────────────────────────────────────────

function findNearCli() {
  // Try npx near-cli-rs, near, near-cli
  const candidates = ['near', 'npx near-cli-rs'];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd.split(' ')[0], ['--version'], { encoding: 'utf8', shell: true });
      if (r.status === 0) return cmd;
    } catch (_) { /* continue */ }
  }
  return null;
}

function execCommand(cmd, opts = {}) {
  core.info(`  $ ${cmd}`);
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout || 120000,
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    return {
      success: false,
      output: err.stdout ? err.stdout.trim() : '',
      error: err.stderr ? err.stderr.trim() : err.message,
    };
  }
}

// ─── Credentials helpers ─────────────────────────────────────────────────────

function writeCredentials(accountId, privateKey, network) {
  // near-cli reads credentials from ~/.near-credentials/<network>/<accountId>.json
  const networkDir = network === 'testnet' ? 'testnet' : 'custom';
  const credDir = path.join(os.homedir(), '.near-credentials', networkDir);
  fs.mkdirSync(credDir, { recursive: true });

  // Determine key type prefix
  let secretKey = privateKey;
  if (!secretKey.startsWith('ed25519:')) {
    secretKey = `ed25519:${secretKey}`;
  }

  const credData = {
    account_id: accountId,
    public_key: '', // will be derived — near-cli only needs secret_key for signing
    private_key: secretKey,
  };

  // near-cli-rs uses different format — write both
  const credFile = path.join(credDir, `${accountId}.json`);
  fs.writeFileSync(credFile, JSON.stringify(credData, null, 2), { mode: 0o600 });
  core.info(`  Credentials written to ${credFile}`);
  return credFile;
}

// Derive public key from ed25519 private key using tweetnacl if available
function derivePublicKey(privateKey) {
  try {
    // try to use near-api-js logic if installed
    const { execSync: ex } = require('child_process');
    const script = `
      const bs58 = require('bs58');
      const nacl = require('tweetnacl');
      const key = '${privateKey}'.replace('ed25519:', '');
      const secretKey = bs58.decode(key);
      const kp = nacl.sign.keyPair.fromSecretKey(secretKey.length === 64 ? secretKey : Buffer.concat([secretKey, nacl.sign.keyPair.fromSeed(secretKey).publicKey]));
      const pubKey = 'ed25519:' + bs58.encode(kp.publicKey);
      process.stdout.write(pubKey);
    `;
    return ex(`node -e "${script.replace(/\n/g, ' ')}"`, { encoding: 'utf8', timeout: 10000 });
  } catch (_) {
    return null;
  }
}

// ─── Step 1: Auto-create testnet account if needed ───────────────────────────

async function stepCreateAccount(rpcUrl, accountId, privateKey, network) {
  core.startGroup('Step 1 — Auto-create testnet account if needed');
  core.info(`Checking existence of account: ${accountId}`);

  const exists = await accountExists(rpcUrl, accountId);

  if (exists) {
    core.info(`✓ Account ${accountId} already exists — skipping creation`);
    core.endGroup();
    return { created: false, accountId };
  }

  core.info(`Account ${accountId} not found — attempting to create via testnet helper…`);

  // NEAR testnet allows creating accounts via the helper API
  const helperUrl = 'https://helper.testnet.near.org';

  // Derive public key
  let pubKey = derivePublicKey(privateKey);
  if (!pubKey) {
    // Fallback: attempt to get public key via near keygen
    const r = execCommand(`node -e "const kp=require('@near-js/crypto')?.KeyPairEd25519||require('near-api-js')?.utils?.KeyPairEd25519; if(kp){const k=kp.fromString('${privateKey}');console.log(k.getPublicKey().toString());}"`);
    if (r.success && r.output) {
      pubKey = r.output.trim();
    }
  }

  if (!pubKey) {
    // Last resort: embed minimal base58 + nacl derivation inline
    core.warning('Could not derive public key automatically; account creation via helper may fail');
    pubKey = `ed25519:UNKNOWN`;
  }

  core.info(`  Public key: ${pubKey}`);

  // POST to testnet helper — create account
  const createPayload = {
    newAccountId: accountId,
    newAccountPublicKey: pubKey,
  };

  try {
    const resp = await httpRequest(
      `${helperUrl}/account`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      },
      createPayload,
    );

    core.info(`  Helper response status: ${resp.statusCode}`);
    core.info(`  Helper response body: ${resp.body}`);

    if (resp.statusCode === 200 || resp.statusCode === 201) {
      core.info(`✓ Account ${accountId} created successfully via testnet helper`);
    } else if (resp.statusCode === 400 && resp.body.includes('already exists')) {
      core.info(`Account already exists (race condition) — continuing`);
    } else {
      throw new Error(`Helper returned ${resp.statusCode}: ${resp.body}`);
    }
  } catch (helperErr) {
    core.warning(`Testnet helper creation failed: ${helperErr.message}`);
    core.warning('Continuing — account may exist or will be created differently');
  }

  // Wait for account to propagate
  core.info('  Waiting for account to propagate on network…');
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const nowExists = await accountExists(rpcUrl, accountId);
    if (nowExists) {
      core.info(`✓ Account ${accountId} confirmed on-chain`);
      core.endGroup();
      return { created: true, accountId };
    }
    core.info(`  Attempt ${i + 1}/10 — not yet visible, retrying…`);
  }

  core.warning(`Account ${accountId} not yet visible after creation attempts — continuing optimistically`);
  core.endGroup();
  return { created: true, accountId };
}

// ─── Step 2: Request faucet funding ──────────────────────────────────────────

async function stepFaucetFunding(rpcUrl, accountId, faucetAmount, network) {
  core.startGroup('Step 2 — Request faucet funding');
  core.info(`Requesting ${faucetAmount} NEAR for account: ${accountId}`);

  // Check current balance first
  let currentBalance = { near: 0 };
  try {
    currentBalance = await getAccountBalance(rpcUrl, accountId);
    core.info(`  Current balance: ${currentBalance.near.toFixed(4)} NEAR`);
  } catch (_) {
    core.info('  Could not fetch current balance (account may not exist yet)');
  }

  // NEAR testnet faucet endpoints
  const faucetEndpoints = [
    {
      url: 'https://near-faucet.io/api/faucet/tokens',
      buildPayload: () => ({ account: accountId }),
      method: 'POST',
    },
    {
      url: `https://helper.testnet.near.org/account/${accountId}/fundAccount`,
      buildPayload: () => ({}),
      method: 'POST',
    },
  ];

  let funded = false;

  for (const endpoint of faucetEndpoints) {
    try {
      core.info(`  Trying faucet: ${endpoint.url}`);
      const resp = await httpRequest(
        endpoint.url,
        {
          method: endpoint.method,
          headers: { 'Content-Type': 'application/json' },
          timeout: 20000,
        },
        endpoint.buildPayload(),
      );

      core.info(`  Faucet response [${resp.statusCode}]: ${resp.body.slice(0, 200)}`);

      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        core.info(`  ✓ Faucet request accepted`);
        funded = true;
        break;
      }
    } catch (err) {
      core.info(`  Faucet endpoint failed: ${err.message}`);
    }
  }

  if (!funded) {
    core.warning('No faucet endpoint succeeded — account must already be funded or funded via other means');
  }

  // Wait and verify balance
  core.info('  Waiting for balance to update…');
  await sleep(5000);

  let finalBalance = { near: 0 };
  try {
    finalBalance = await getAccountBalance(rpcUrl, accountId);
    core.info(`  Balance after funding: ${finalBalance.near.toFixed(4)} NEAR`);

    if (finalBalance.near < 0.1) {
      core.warning(`Balance (${finalBalance.near.toFixed(4)} NEAR) is very low — deployment may fail`);
    } else {
      core.info(`✓ Account has sufficient balance: ${finalBalance.near.toFixed(4)} NEAR`);
    }
  } catch (err) {
    core.warning(`Could not verify balance: ${err.message}`);
  }

  core.setOutput('account_balance', finalBalance.near.toFixed(4));
  core.endGroup();
  return { funded, balance: finalBalance.near };
}

// ─── Step 3: Build & Deploy contract ─────────────────────────────────────────

async function stepDeployContract(rpcUrl, accountId, privateKey, contractPath, network) {
  core.startGroup('Step 3 — Build & Deploy contract');

  const absContractPath = path.resolve(contractPath);
  core.info(`Contract path: ${absContractPath}`);

  if (!fs.existsSync(absContractPath)) {
    throw new Error(`Contract path does not exist: ${absContractPath}`);
  }

  // Write credentials for near-cli
  writeCredentials(accountId, privateKey, network);

  // Determine the WASM file path
  let wasmFile = null;

  const stat = fs.statSync(absContractPath);

  if (stat.isFile() && absContractPath.endsWith('.wasm')) {
    wasmFile = absContractPath;
    core.info(`  Using pre-compiled WASM: ${wasmFile}`);
  } else if (stat.isDirectory()) {
    // Try to find existing WASM first
    const candidates = [
      path.join(absContractPath, 'res', `${path.basename(absContractPath)}.wasm`),
      path.join(absContractPath, 'out', 'main.wasm'),
      path.join(absContractPath, 'target', 'wasm32-unknown-unknown', 'release', `${path.basename(absContractPath).replace(/-/g, '_')}.wasm`),
      // near-sdk-js output
      path.join(absContractPath, 'build', 'contract.wasm'),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        wasmFile = c;
        core.info(`  Found existing WASM: ${wasmFile}`);
        break;
      }
    }

    if (!wasmFile) {
      // Need to build
      core.info('  No pre-compiled WASM found — attempting to build…');
      wasmFile = await buildContract(absContractPath);
    }
  } else {
    throw new Error(`contractPath must be a .wasm file or a contract directory. Got: ${absContractPath}`);
  }

  if (!fs.existsSync(wasmFile)) {
    throw new Error(`WASM file not found after build: ${wasmFile}`);
  }

  const wasmSize = fs.statSync(wasmFile).size;
  core.info(`  WASM size: ${(wasmSize / 1024).toFixed(1)} KB`);

  // Deploy using near-cli or direct RPC
  core.info(`  Deploying ${wasmFile} to ${accountId} on ${network}…`);

  const networkId = network === 'testnet' ? 'testnet' : 'testnet';
  const nodeUrl = resolveRpcUrl(network);

  // Try near-cli first
  const nearCli = findNearCli();
  let deployResult = null;

  if (nearCli) {
    core.info(`  Using near-cli: ${nearCli}`);
    const deployCmd = `${nearCli} deploy --accountId ${accountId} --wasmFile ${wasmFile} --networkId ${networkId} --nodeUrl ${nodeUrl} --keyPath ${path.join(os.homedir(), '.near-credentials', networkId, `${accountId}.json`)}`;
    deployResult = execCommand(deployCmd, { timeout: 90000 });

    if (deployResult.success) {
      core.info(`  ✓ Deploy via near-cli succeeded`);
      core.info(`  Output: ${deployResult.output}`);
    } else {
      core.warning(`  near-cli deploy failed: ${deployResult.error}`);
      core.info('  Falling back to direct RPC deployment…');
      deployResult = null;
    }
  }

  // Fallback: deploy via direct RPC call with near-api-js
  if (!deployResult || !deployResult.success) {
    deployResult = await deployViaNodeScript(accountId, privateKey, wasmFile, nodeUrl, networkId);
  }

  if (!deployResult.success) {
    throw new Error(`Contract deployment failed: ${deployResult.error || 'Unknown error'}`);
  }

  core.info(`✓ Contract deployed successfully to ${accountId}`);

  // Extract transaction hash from output
  const txHashMatch = (deployResult.output || '').match(/Transaction ID:\s*([A-Za-z0-9]+)/) ||
    (deployResult.output || '').match(/"hash":\s*"([A-Za-z0-9]+)"/);
  const txHash = txHashMatch ? txHashMatch[1] : 'unknown';

  core.setOutput('transaction_hash', txHash);
  core.info(`  Transaction hash: ${txHash}`);

  core.endGroup();
  return { wasmFile, txHash, deployOutput: deployResult.output };
}

async function buildContract(contractDir) {
  core.info(`  Building contract in ${contractDir}…`);

  // Detect project type
  const hasCargo = fs.existsSync(path.join(contractDir, 'Cargo.toml'));
  const hasPackageJson = fs.existsSync(path.join(contractDir, 'package.json'));

  if (hasCargo) {
    core.info('  Detected Rust/NEAR SDK project');

    // Install wasm32 target if needed
    const targetCheck = execCommand('rustup target list --installed');
    if (!targetCheck.output.includes('wasm32-unknown-unknown')) {
      core.info('  Adding wasm32-unknown-unknown target…');
      const addTarget = execCommand('rustup target add wasm32-unknown-unknown');
      if (!addTarget.success) {
        throw new Error(`Failed to add wasm32 target: ${addTarget.error}`);
      }
    }

    // Try build script first
    const buildSh = path.join(contractDir, 'build.sh');
    if (fs.existsSync(buildSh)) {
      core.info('  Running build.sh…');
      const r = execCommand(`bash ${buildSh}`, { timeout: 300000 });
      if (!r.success) throw new Error(`build.sh failed: ${r.error}`);
    } else {
      // Standard cargo build
      const cargoToml = fs.readFileSync(path.join(contractDir, 'Cargo.toml'), 'utf8');
      const nameMatch = cargoToml.match(/^name\s*=\s*"([^"]+)"/m);
      const crateName = nameMatch ? nameMatch[1].replace(/-/g, '_') : 'contract';

      core.info(`  Running cargo build --target wasm32-unknown-unknown --release…`);
      const r = execCommand(
        `cargo build --target wasm32-unknown-unknown --release --manifest-path ${path.join(contractDir, 'Cargo.toml')}`,
        { timeout: 300000 },
      );
      if (!r.success) throw new Error(`cargo build failed: ${r.error}`);

      const wasmPath = path.join(contractDir, 'target', 'wasm32-unknown-unknown', 'release', `${crateName}.wasm`);
      if (fs.existsSync(wasmPath)) return wasmPath;

      // Search for any .wasm produced
      const searchResult = execCommand(`find ${path.join(contractDir, 'target', 'wasm32-unknown-unknown', 'release')} -name "*.wasm" -not -path "*/deps/*" 2>/dev/null | head -1`);
      if (searchResult.success && searchResult.output) return searchResult.output.trim();
    }

    // Search for wasm file
    const findResult = execCommand(`find ${contractDir} -name "*.wasm" -not -path "*/deps/*" 2>/dev/null | head -1`);
    if (findResult.success && findResult.output) return findResult.output.trim();
    throw new Error('No WASM file found after Rust build');
  }

  if (hasPackageJson) {
    core.info('