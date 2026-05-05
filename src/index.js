async function nearRpc(method, params) {
  const RPC_URL = 'https://rpc.testnet.near.org';
  const body = { jsonrpc: '2.0', id: 'action', method, params };
  const res = await request(RPC_URL, { method: 'POST' }, body);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Failed to parse RPC response: ${res.body}`);
  }
  if (parsed.error) {
    throw new Error(`RPC error [${method}]: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

// ---------------------------------------------------------------------------
// Utility: Derive Ed25519 public key from a private key (hex or base58)
// Uses Node's built-in crypto via nacl-like manual approach, but we rely on
// the tweetnacl package bundled in node_modules at action runtime.
// ---------------------------------------------------------------------------
function loadNacl() {
  // tweetnacl must be in package.json dependencies
  try {
    return require('tweetnacl');
  } catch (e) {
    throw new Error(
      'tweetnacl not found. Ensure tweetnacl is listed in package.json dependencies and node_modules is bundled.'
    );
  }
}

function loadBs58() {
  try {
    return require('bs58');
  } catch (e) {
    throw new Error(
      'bs58 not found. Ensure bs58 is listed in package.json dependencies and node_modules is bundled.'
    );
  }
}

/**
 * Parse a NEAR private key string in any supported format:
 *  - "ed25519:<base58-encoded-64-byte-seed>"  (NEAR keystore format)
 *  - raw hex string (64 hex chars = 32 bytes seed, or 128 hex chars = 64 bytes keypair)
 *  - raw base58 string (32 or 64 byte seed)
 *
 * Returns a Uint8Array of 32 bytes (the seed / secret key scalar).
 */
function parsePrivateKeySeed(privateKeyStr) {
  const bs58 = loadBs58();

  const trimmed = privateKeyStr.trim();

  // Format: "ed25519:<base58>"
  if (trimmed.startsWith('ed25519:')) {
    const b58Part = trimmed.slice('ed25519:'.length);
    const decoded = bs58.decode(b58Part);
    // NEAR stores 64-byte keypair (seed || public) or just 32-byte seed
    if (decoded.length === 64) {
      return decoded.slice(0, 32); // first 32 bytes are the seed
    }
    if (decoded.length === 32) {
      return decoded;
    }
    throw new Error(
      `Unexpected ed25519 key length after base58 decode: ${decoded.length}`
    );
  }

  // Format: hex string
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    if (trimmed.length === 64) {
      // 32 bytes
      return Buffer.from(trimmed, 'hex');
    }
    if (trimmed.length === 128) {
      // 64 bytes — take first 32 as seed
      return Buffer.from(trimmed.slice(0, 64), 'hex');
    }
    throw new Error(`Unexpected hex private key length: ${trimmed.length} chars`);
  }

  // Fallback: try raw base58
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 64) return decoded.slice(0, 32);
    if (decoded.length === 32) return decoded;
    throw new Error(`Unexpected base58 key length: ${decoded.length}`);
  } catch (e) {
    throw new Error(
      `Cannot parse private key. Supported formats: "ed25519:<base58>", hex (64 or 128 chars), base58. Error: ${e.message}`
    );
  }
}

/**
 * Derive Ed25519 public key from private key string.
 * Returns the public key as a base58-encoded string (NEAR format: "ed25519:<base58>").
 */
function derivePublicKey(privateKeyStr) {
  const nacl = loadNacl();
  const bs58 = loadBs58();

  const seed = parsePrivateKeySeed(privateKeyStr);
  // nacl.sign.keyPair.fromSeed expects exactly 32 bytes
  const seedBytes = new Uint8Array(seed.buffer, seed.byteOffset, 32);
  const keyPair = nacl.sign.keyPair.fromSeed(seedBytes);
  const publicKeyB58 = bs58.encode(Buffer.from(keyPair.publicKey));
  return `ed25519:${publicKeyB58}`;
}

// ---------------------------------------------------------------------------
// Utility: exec helper that streams output and throws on non-zero exit
// ---------------------------------------------------------------------------
function exec(cmd, options = {}) {
  core.info(`$ ${cmd}`);
  const result = spawnSync(cmd, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
    cwd: options.cwd || process.cwd(),
    timeout: options.timeout || 300000,
  });

  const stdout = result.stdout ? result.stdout.toString() : '';
  const stderr = result.stderr ? result.stderr.toString() : '';

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  if (result.status !== 0) {
    throw new Error(
      `Command failed (exit ${result.status}): ${cmd}\nstderr: ${stderr}`
    );
  }
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Utility: sleep
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Utility: Write NEAR credentials file so near-cli can authenticate
// ---------------------------------------------------------------------------
function writeCredentials(accountId, privateKeyStr, publicKeyStr) {
  const nearDir = path.join(os.homedir(), '.near-credentials', 'testnet');
  fs.mkdirSync(nearDir, { recursive: true });

  const credFile = path.join(nearDir, `${accountId}.json`);
  const cred = {
    account_id: accountId,
    public_key: publicKeyStr,
    private_key: privateKeyStr,
  };
  fs.writeFileSync(credFile, JSON.stringify(cred, null, 2), { mode: 0o600 });
  core.info(`Credentials written to ${credFile}`);
  return credFile;
}

// ---------------------------------------------------------------------------
// STEP 1: Install near-cli at requested version
// ---------------------------------------------------------------------------
async function stepInstallNearCli(nearCliVersion) {
  core.startGroup('Step 1: Install NEAR CLI');
  try {
    const versionArg =
      nearCliVersion === 'latest' ? 'near-cli' : `near-cli@${nearCliVersion}`;
    core.info(`Installing ${versionArg} globally…`);
    exec(`npm install -g ${versionArg}`);

    const version = exec('near --version');
    core.info(`NEAR CLI installed: ${version}`);
    return version;
  } finally {
    core.endGroup();
  }
}

// ---------------------------------------------------------------------------
// STEP 2: Check whether the account already exists on testnet
// ---------------------------------------------------------------------------
async function stepCheckAccountExists(accountId) {
  core.startGroup(`Step 2: Check account existence — ${accountId}`);
  try {
    core.info(`Querying RPC for account: ${accountId}`);
    try {
      const result = await nearRpc('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      core.info(`Account exists. Balance: ${result.amount} yoctoNEAR`);
      return true;
    } catch (e) {
      if (
        e.message.includes('does not exist') ||
        e.message.includes('UNKNOWN_ACCOUNT') ||
        e.message.includes('unknown account')
      ) {
        core.info('Account does not exist yet — will create it.');
        return false;
      }
      throw e;
    }
  } finally {
    core.endGroup();
  }
}

// ---------------------------------------------------------------------------
// STEP 3: Create testnet account via helper contract (faucet)
// ---------------------------------------------------------------------------
async function stepCreateAccount(accountId, publicKeyStr) {
  core.startGroup(`Step 3: Create testnet account — ${accountId}`);
  try {
    // NEAR testnet helper endpoint for account creation
    const HELPER_URL = 'https://helper.testnet.near.org';
    const body = {
      newAccountId: accountId,
      newAccountPublicKey: publicKeyStr,
    };

    core.info(
      `Requesting account creation from helper with public key: ${publicKeyStr}`
    );
    const res = await request(
      `${HELPER_URL}/account`,
      { method: 'POST' },
      body
    );

    core.info(`Helper response status: ${res.status}`);
    core.info(`Helper response body: ${res.body}`);

    if (res.status === 200 || res.status === 201) {
      core.info(`Account ${accountId} created successfully.`);
      // Wait for account to be indexed
      await sleep(5000);
      return true;
    }

    // Some helper versions return 204
    if (res.status === 204) {
      core.info(`Account ${accountId} created (204 No Content).`);
      await sleep(5000);
      return true;
    }

    throw new Error(
      `Account creation failed. HTTP ${res.status}: ${res.body}`
    );
  } finally {
    core.endGroup();
  }
}

// ---------------------------------------------------------------------------
// STEP 4: Request faucet funding
// ---------------------------------------------------------------------------
async function stepRequestFunding(accountId, publicKeyStr, faucetAmountNear) {
  core.startGroup(`Step 4: Request faucet funding — ${faucetAmountNear} NEAR`);
  try {
    // Primary: NEAR testnet faucet
    const FAUCET_URL = 'https://helper.testnet.near.org';

    // Convert NEAR to yoctoNEAR for display (faucet typically sends a fixed amount)
    const amountFloat = parseFloat(faucetAmountNear);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error(`Invalid faucet_amount: ${faucetAmountNear}`);
    }

    core.info(
      `Requesting ${amountFloat} NEAR for account ${accountId} from ${FAUCET_URL}`
    );

    // The NEAR testnet helper /account endpoint already funds the account;
    // for additional funding we call the faucet endpoint.
    const body = {
      account_id: accountId,
      public_key: publicKeyStr,
      amount: String(amountFloat),
    };

    const res = await request(
      `${FAUCET_URL}/account/fund`,
      { method: 'POST' },
      body
    );

    core.info(`Faucet response status: ${res.status}`);
    core.info(`Faucet response body: ${res.body}`);

    // Faucet may not support additional top-up beyond initial balance;
    // treat 4xx as a warning (account was already funded during creation)
    if (res.status >= 200 && res.status < 300) {
      core.info('Faucet funding request accepted.');
    } else if (res.status === 400 || res.status === 404) {
      core.warning(
        `Faucet returned ${res.status} — account may already be funded. Continuing.`
      );
    } else if (res.status === 500) {
      core.warning(
        `Faucet returned 500 — endpoint may not support top-up. Continuing with existing balance.`
      );
    } else {
      throw new Error(`Faucet request failed. HTTP ${res.status}: ${res.body}`);
    }

    // Verify balance after funding attempt
    await sleep(3000);
    const accountState = await nearRpc('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });

    const balanceYocto = BigInt(accountState.amount);
    const balanceNear = Number(balanceYocto) / 1e24;
    core.info(`Current balance: ${balanceNear.toFixed(4)} NEAR`);
    return balanceNear;
  } finally {
    core.endGroup();
  }
}

// ---------------------------------------------------------------------------
// STEP 5: Locate and/or build the WASM contract
// ---------------------------------------------------------------------------
async function stepPrepareContract(contractPath) {
  core.startGroup('Step 5: Prepare contract for deployment');
  try {
    const resolved = path.resolve(contractPath);
    core.info(`Contract path (resolved): ${resolved}`);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Contract path does not exist: ${resolved}`);
    }

    const stat = fs.statSync(resolved);

    // If it's already a .wasm file, use it directly
    if (stat.isFile() && resolved.endsWith('.wasm')) {
      core.info(`Using pre-compiled WASM: ${resolved}`);
      return resolved;
    }

    // If it's a directory, look for existing WASM or attempt build
    if (stat.isDirectory()) {
      // Check common output locations
      const candidates = [
        path.join(resolved, 'res'),
        path.join(resolved, 'out'),
        path.join(resolved, 'target', 'wasm32-unknown-unknown', 'release'),
        path.join(resolved, 'build'),
      ];

      for (const dir of candidates) {
        if (fs.existsSync(dir)) {
          const wasmFiles = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.wasm'));
          if (wasmFiles.length > 0) {
            const wasmPath = path.join(dir, wasmFiles[0]);
            core.info(`Found existing WASM: ${wasmPath}`);
            return wasmPath;
          }
        }
      }

      // Try to build — detect project type
      const pkgJson = path.join(resolved, 'package.json');
      const cargoToml = path.join(resolved, 'Cargo.toml');

      if (fs.existsSync(pkgJson)) {
        core.info('Detected Node.js/AssemblyScript project — running npm install && npm run build');
        exec('npm install', { cwd: resolved });
        exec('npm run build', { cwd: resolved });

        // Re-scan after build
        for (const dir of candidates) {
          if (fs.existsSync(dir)) {
            const wasmFiles = fs
              .readdirSync(dir)
              .filter((f) => f.endsWith('.wasm'));
            if (wasmFiles.length > 0) {
              const wasmPath = path.join(dir, wasmFiles[0]);
              core.info(`Built WASM: ${wasmPath}`);
              return wasmPath;
            }
          }
        }
      } else if (fs.existsSync(cargoToml)) {
        core.info('Detected Rust project — running cargo build --release (wasm32 target)');
        // Ensure wasm target is present
        try {
          exec('rustup target add wasm32-unknown-unknown');
        } catch (_) {
          core.warning('Could not add wasm32 target — it may already be present.');
        }
        exec('cargo build --target wasm32-unknown-unknown --release', {
          cwd: resolved,
        });
        const releaseDir = path.join(
          resolved,
          'target',
          'wasm32-unknown-unknown',
          'release'
        );
        if (fs.existsSync(releaseDir)) {
          const wasmFiles = fs
            .readdirSync(releaseDir)
            .filter((f) => f.endsWith('.wasm') && !f.endsWith('.d.wasm'));
          if (wasmFiles.length > 0) {
            const wasmPath = path.join(releaseDir, wasmFiles[0]);
            core.info(`Built WASM: ${wasmPath}`);
            return wasmPath;
          }
        }
      }

      throw new Error(
        `No WASM file found in ${resolved} and could not determine how to build it. ` +
          'Please provide a path directly to a .wasm file, or ensure your build produces a .wasm in a standard location.'
      );
    }

    throw new Error(
      `contract_path must be a .wasm file or a project directory. Got: ${resolved}`
    );
  } finally {
    core.endGroup();
  }
}

// ---------------------------------------------------------------------------
// STEP 6: Deploy the contract using near-cli
// ---------------------------------------------------------------------------
async function stepDeployContract(accountId, wasmPath, privateKeyStr) {
  core.startGroup(`Step 6: Deploy contract — ${path.basename(wasmPath)}`);
  try {
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found at deploy time: ${wasmPath}`);
    }

    const wasmSize = fs.statSync(wasmPath).size;
    core.info(`WASM size: ${(wasmSize / 1024).toFixed(2)} KB`);

    // near-cli reads credentials from ~/.near-credentials/testnet/<accountId>.json
    // which we wrote in writeCredentials() earlier.
    const deployCmd = [
      'near deploy',
      `--accountId ${accountId}`,
      `--wasmFile ${wasmPath}`,
      '--networkId testnet',
      '--nodeUrl https://rpc.testnet.near.org',
    ].join(' ');

    const output = exec(deployCmd, {
      env: { ...process.env, NEAR_ENV: 'testnet' },
    });

    core.info('Deploy output:');
    core.info(output);

    // Extract transaction hash from near-cli output
    const txHashMatch = output.match(/Transaction Id ([A-Za-z0-9]+)/);
    const txHash = txHashMatch ? txHashMatch[1] : null;

    if (txHash) {
      core.info(`Deploy transaction hash: ${txHash}`);
    } else {
      core.warning('Could not extract transaction hash from deploy output.');
    }

    // Verify deployment by checking contract code on-chain
    core.info('Verifying deployment on-chain…');
    await sleep(3000);
    const codeResult = await nearRpc('query', {
      request_type: 'view_code',
      finality: 'final',
      account_id: accountId,
    });

    if (!codeResult || !codeResult.code_base64) {
      throw new Error('Deployment verification failed: no contract code found on-chain.');
    }

    const deployedBytes = Buffer.from(codeResult.code_base64, 'base64').length;
    core.info(
      `Deployment verified. On-chain contract size: ${(deployedBytes / 1024).toFixed(2)} KB`
    );

    return { txHash, deployedBytes };
  } finally {
    core.endGroup();
  }
}

// ---------------------------------------------------------------------------
// STEP 7: Run smoke tests
// ---------------------------------------------------------------------------
async function stepRunSmokeTests(testCommand, contractPath, accountId) {
  core.startGroup(`Step 7: Run smoke tests — ${testCommand}`);
  try {
    // Determine working directory: use contract directory if path is a file,
    // otherwise use the directory itself.
    let cwd;
    const resolved = path.resolve(contractPath);
    const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;

    if (stat && stat.isDirectory()) {
      cwd = resolved;
    } else if (stat && stat.isFile()) {
      cwd = path.dirname(resolved);
    } else {
      cwd = process.cwd();
    }

    core.info(`Test working directory: ${cwd}`);
    core.info(`Running: ${testCommand}`);

    const testEnv = {
      ...process.env,
      NEAR_ENV: 'testnet',
      NEAR_TESTNET_ACCOUNT: accountId,
      CONTRACT_ACCOUNT_ID: accountId,
    };

    // Run the test command; capture output but also stream it
    const result = spawnSync(testCommand, {
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: testEnv,
      cwd,
      timeout: 300000,
    });

    const stdout = result.stdout ? result.stdout.toString() : '';
    const stderr = result.stderr ? result.stderr.toString() : '';

    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    if (result.status !== 0) {
      throw new Error(
        `Smoke tests failed with exit code ${result.status}.\nstderr: ${stderr}`
      );
    }

    core.info('