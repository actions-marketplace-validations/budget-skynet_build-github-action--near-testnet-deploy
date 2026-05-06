async function nearRpc(method, params) {
  const res = await httpsPost(NEAR_RPC, {
    jsonrpc: '2.0',
    id: 'near-testnet-action',
    method,
    params,
  });
  if (res.body && res.body.error) {
    throw new Error(`NEAR RPC error (${method}): ${JSON.stringify(res.body.error)}`);
  }
  return res.body.result;
}

// ─── Shell helper ────────────────────────────────────────────────────────────

function sh(cmd, opts = {}) {
  core.debug(`$ ${cmd}`);
  const output = execSync(cmd, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
  return output ? output.trim() : '';
}

function shAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    core.debug(`$ ${cmd}`);
    exec(cmd, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// ─── Step 1 – Resolve & validate inputs ──────────────────────────────────────

function resolveInputs() {
  core.startGroup('📋 Resolving inputs');

  const contractPath    = core.getInput('contract_path', { required: true });
  const accountId       = core.getInput('testnet_account_id', { required: true });
  const privateKey      = core.getInput('testnet_private_key', { required: true });
  const faucetAmount    = core.getInput('faucet_amount')    || '10';
  const testCommand     = core.getInput('test_command')     || 'npm test';
  const autoCreate      = (core.getInput('auto_create_account') || 'true').toLowerCase() !== 'false';

  // Validate account ID format  (letters, digits, hyphen, underscore, dot — ends with .testnet)
  if (!/^[a-z0-9_\-.]{2,64}$/.test(accountId)) {
    throw new Error(`Invalid testnet_account_id: "${accountId}"`);
  }
  if (!accountId.endsWith('.testnet')) {
    throw new Error(`testnet_account_id must end with ".testnet", got: "${accountId}"`);
  }

  // Validate private key format
  if (!privateKey.startsWith('ed25519:') && privateKey.length < 64) {
    throw new Error('testnet_private_key appears malformed – expected ed25519:<base58> or raw base58');
  }

  // Validate faucet amount
  const faucetAmountNum = parseFloat(faucetAmount);
  if (isNaN(faucetAmountNum) || faucetAmountNum <= 0) {
    throw new Error(`faucet_amount must be a positive number, got: "${faucetAmount}"`);
  }

  // Resolve contract path
  const absContractPath = path.resolve(contractPath);
  if (!fs.existsSync(absContractPath)) {
    throw new Error(`contract_path does not exist: ${absContractPath}`);
  }

  core.info(`  account_id     : ${accountId}`);
  core.info(`  contract_path  : ${absContractPath}`);
  core.info(`  faucet_amount  : ${faucetAmount} NEAR`);
  core.info(`  test_command   : ${testCommand}`);
  core.info(`  auto_create    : ${autoCreate}`);
  core.endGroup();

  return { contractPath: absContractPath, accountId, privateKey, faucetAmount, testCommand, autoCreate };
}

// ─── Step 2 – Ensure near-cli is available ────────────────────────────────────

async function ensureNearCli() {
  core.startGroup('🔧 Ensuring NEAR CLI is available');
  try {
    const ver = sh('npx near --version 2>/dev/null || near --version');
    core.info(`NEAR CLI: ${ver}`);
  } catch {
    core.info('NEAR CLI not found – installing near-cli globally …');
    sh('npm install -g near-cli', { stdio: 'inherit' });
    const ver = sh('near --version');
    core.info(`Installed NEAR CLI: ${ver}`);
  }
  core.endGroup();
}

// ─── Step 3 – Check / create testnet account ─────────────────────────────────

async function ensureAccount({ accountId, privateKey, autoCreate }) {
  core.startGroup(`👤 Checking testnet account: ${accountId}`);

  let accountExists = false;
  try {
    const result = await nearRpc('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    const balanceYocto = BigInt(result.amount);
    const balanceNear  = Number(balanceYocto) / 1e24;
    core.info(`Account exists. Balance: ${balanceNear.toFixed(4)} NEAR`);
    accountExists = true;
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) {
      core.info(`Account ${accountId} does not exist on testnet.`);
    } else {
      // RPC might be flaky – log but continue
      core.warning(`RPC account check failed: ${err.message}`);
    }
  }

  if (!accountExists) {
    if (!autoCreate) {
      throw new Error(
        `Account ${accountId} does not exist and auto_create_account is false.`
      );
    }

    core.info(`Creating account ${accountId} via NEAR testnet helper …`);

    // Use the helper.testnet.near.org contract-based account creator
    const createRes = await httpsPost(
      'https://helper.testnet.near.org/account',
      {
        newAccountId: accountId,
        newAccountPublicKey: normalisePublicKey(privateKey),
      }
    );

    if (createRes.status !== 200) {
      throw new Error(
        `Failed to create account via helper (HTTP ${createRes.status}): ${JSON.stringify(createRes.body)}`
      );
    }
    core.info(`✅ Account ${accountId} created successfully.`);
  }

  // Write credentials file so near-cli can use them
  writeCredentials(accountId, privateKey);

  core.endGroup();
  return { accountExists };
}

// ─── Step 4 – Request faucet funding ─────────────────────────────────────────

async function requestFaucetFunding({ accountId, faucetAmount }) {
  core.startGroup(`💰 Requesting ${faucetAmount} NEAR from faucet for ${accountId}`);

  // Faucet endpoint (testnet)
  const faucetUrl = 'https://helper.testnet.near.org/account/funds';
  const res = await httpsPost(faucetUrl, {
    accountId,
    amount: String(Math.floor(parseFloat(faucetAmount) * 1e24)), // in yoctoNEAR
  });

  if (res.status === 200 || res.status === 201) {
    core.info(`✅ Faucet request accepted (HTTP ${res.status}).`);
  } else if (res.status === 429) {
    core.warning('Faucet rate-limited (HTTP 429) – continuing without fresh funding.');
  } else {
    // Non-fatal – account might already have balance
    core.warning(
      `Faucet responded with HTTP ${res.status}: ${JSON.stringify(res.body)} – continuing.`
    );
  }

  // Wait briefly and confirm balance
  await sleep(3000);
  try {
    const result = await nearRpc('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    const balanceNear = Number(BigInt(result.amount)) / 1e24;
    core.info(`Current balance: ${balanceNear.toFixed(4)} NEAR`);
    core.setOutput('account_balance', balanceNear.toFixed(4));

    if (balanceNear < 1) {
      throw new Error(
        `Insufficient balance (${balanceNear.toFixed(4)} NEAR) to deploy. ` +
        'Try increasing faucet_amount or fund manually.'
      );
    }
  } catch (err) {
    if (err.message.startsWith('Insufficient')) throw err;
    core.warning(`Balance check failed: ${err.message}`);
  }

  core.endGroup();
}

// ─── Step 5 – Build / locate WASM ────────────────────────────────────────────

async function buildContract({ contractPath }) {
  core.startGroup('🔨 Building contract');

  let wasmPath;

  // Direct WASM file supplied
  if (contractPath.endsWith('.wasm')) {
    wasmPath = contractPath;
    core.info(`Using pre-compiled WASM: ${wasmPath}`);
    core.endGroup();
    return { wasmPath };
  }

  // Detect build system
  const hasCargo    = fs.existsSync(path.join(contractPath, 'Cargo.toml'));
  const hasPackage  = fs.existsSync(path.join(contractPath, 'package.json'));

  if (hasCargo) {
    core.info('Detected Rust project – building with cargo …');

    // Ensure wasm32 target
    try { sh('rustup target add wasm32-unknown-unknown'); } catch { /* already installed */ }

    // Prefer cargo-near if available, fall back to plain cargo build
    const hasCargoNear = (() => {
      try { sh('cargo near --version'); return true; } catch { return false; }
    })();

    if (hasCargoNear) {
      sh(`cd "${contractPath}" && cargo near build`, { stdio: 'inherit' });
    } else {
      sh(
        `cd "${contractPath}" && cargo build --target wasm32-unknown-unknown --release`,
        { stdio: 'inherit' }
      );
    }

    // Locate compiled wasm
    const wasmDir = path.join(contractPath, 'res');
    if (fs.existsSync(wasmDir)) {
      const files = fs.readdirSync(wasmDir).filter(f => f.endsWith('.wasm'));
      if (files.length > 0) {
        wasmPath = path.join(wasmDir, files[0]);
      }
    }

    if (!wasmPath) {
      // Search target directory
      const targetDir = path.join(contractPath, 'target', 'wasm32-unknown-unknown', 'release');
      if (fs.existsSync(targetDir)) {
        const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.wasm') && !f.endsWith('.d.wasm'));
        if (files.length > 0) {
          wasmPath = path.join(targetDir, files[0]);
        }
      }
    }

  } else if (hasPackage) {
    core.info('Detected Node.js project – running build …');
    const pkg = JSON.parse(fs.readFileSync(path.join(contractPath, 'package.json'), 'utf8'));

    if (pkg.scripts && pkg.scripts.build) {
      sh(`cd "${contractPath}" && npm ci && npm run build`, { stdio: 'inherit' });
    } else {
      core.warning('No build script found in package.json – looking for pre-built WASM …');
    }

    // Locate wasm
    const buildDir = path.join(contractPath, 'build');
    if (fs.existsSync(buildDir)) {
      const files = fs.readdirSync(buildDir).filter(f => f.endsWith('.wasm'));
      if (files.length > 0) {
        wasmPath = path.join(buildDir, files[0]);
      }
    }

  } else {
    // Scan the directory itself for a wasm file
    const files = fs.readdirSync(contractPath).filter(f => f.endsWith('.wasm'));
    if (files.length > 0) {
      wasmPath = path.join(contractPath, files[0]);
      core.info(`Found WASM: ${wasmPath}`);
    }
  }

  if (!wasmPath || !fs.existsSync(wasmPath)) {
    throw new Error(
      'Build completed but could not locate a .wasm output file. ' +
      'Please ensure your build script produces a .wasm file.'
    );
  }

  const sizeKb = (fs.statSync(wasmPath).size / 1024).toFixed(1);
  core.info(`✅ WASM ready: ${wasmPath} (${sizeKb} KB)`);
  core.setOutput('wasm_path', wasmPath);
  core.endGroup();
  return { wasmPath };
}

// ─── Step 6 – Deploy contract ─────────────────────────────────────────────────

async function deployContract({ accountId, privateKey, wasmPath }) {
  core.startGroup(`🚀 Deploying contract to ${accountId}`);

  const credDir   = credentialsDir();
  const networkId = 'testnet';

  // near deploy uses the credentials stored in ~/.near-credentials
  const cmd = [
    `NEAR_ENV=${networkId}`,
    `HOME=${process.env.HOME}`,
    `near deploy`,
    `--accountId "${accountId}"`,
    `--wasmFile "${wasmPath}"`,
    `--networkId ${networkId}`,
    `--keyPath "${path.join(credDir, networkId, `${accountId}.json`)}"`,
    `--verbose`,
  ].join(' ');

  let deployOutput;
  try {
    const { stdout, stderr } = await shAsync(cmd);
    deployOutput = stdout + '\n' + stderr;
    core.info(deployOutput);
  } catch (err) {
    core.error(`Deploy failed:\n${err.stdout}\n${err.stderr}`);
    throw new Error(`Contract deployment failed: ${err.message}`);
  }

  // Extract transaction hash from output
  const txHashMatch = deployOutput.match(/Transaction Id\s+([A-Za-z0-9]+)/);
  const txHash = txHashMatch ? txHashMatch[1] : null;
  if (txHash) {
    core.info(`Transaction hash: ${txHash}`);
    core.setOutput('deploy_tx_hash', txHash);

    const explorerUrl = `https://explorer.testnet.near.org/transactions/${txHash}`;
    core.info(`Explorer: ${explorerUrl}`);
    core.setOutput('explorer_url', explorerUrl);
  }

  // Verify deployment by querying contract code
  await sleep(2000);
  try {
    const codeResult = await nearRpc('query', {
      request_type: 'view_code',
      finality: 'final',
      account_id: accountId,
    });
    const codeSizeB = Buffer.from(codeResult.code_base64 || '', 'base64').length;
    core.info(`✅ Contract verified on-chain (code size: ${(codeSizeB / 1024).toFixed(1)} KB)`);
    core.setOutput('deployed_account_id', accountId);
  } catch (err) {
    throw new Error(`Deployment verification failed – contract not found on-chain: ${err.message}`);
  }

  core.endGroup();
  return { txHash };
}

// ─── Step 7 – Run smoke tests ─────────────────────────────────────────────────

async function runSmokeTests({ contractPath, accountId, testCommand }) {
  core.startGroup('🧪 Running smoke tests');

  // Inject helpful env vars that test scripts can use
  const testEnv = {
    ...process.env,
    NEAR_ENV: 'testnet',
    NEAR_ACCOUNT_ID: accountId,
    CONTRACT_ACCOUNT_ID: accountId,
    NEAR_NETWORK: 'testnet',
    NEAR_RPC_URL: NEAR_RPC,
  };

  // Determine working directory for test command
  let cwd = contractPath;
  if (contractPath.endsWith('.wasm')) {
    cwd = path.dirname(contractPath);
  }

  // If the cwd has a package.json and node_modules missing, install first
  if (
    fs.existsSync(path.join(cwd, 'package.json')) &&
    !fs.existsSync(path.join(cwd, 'node_modules'))
  ) {
    core.info('Installing test dependencies …');
    sh(`cd "${cwd}" && npm ci`, { stdio: 'inherit' });
  }

  core.info(`Running: ${testCommand}`);
  core.info(`Working dir: ${cwd}`);

  let testsPassed = false;
  let testOutput  = '';

  try {
    const { stdout, stderr } = await shAsync(testCommand, { cwd, env: testEnv });
    testOutput = stdout + '\n' + stderr;
    core.info(testOutput);
    testsPassed = true;
    core.info('✅ Smoke tests passed.');
  } catch (err) {
    testOutput = (err.stdout || '') + '\n' + (err.stderr || '');
    core.error(`Tests failed:\n${testOutput}`);
    core.setOutput('test_passed', 'false');
    throw new Error(`Smoke tests failed: ${err.message}`);
  }

  core.setOutput('test_passed', String(testsPassed));
  core.endGroup();
  return { testsPassed, testOutput };
}

// ─── Step 8 – Report results ──────────────────────────────────────────────────

function reportResults({ accountId, txHash, testsPassed, wasmPath, faucetAmount }) {
  core.startGroup('📊 Deployment Summary');

  const explorerUrl = txHash
    ? `https://explorer.testnet.near.org/transactions/${txHash}`
    : `https://explorer.testnet.near.org/accounts/${accountId}`;

  const summary = [
    '## 🚀 NEAR Testnet Deployment Summary',
    '',
    '| Field | Value |',
    '| ----- | ----- |',
    `| **Account** | \`${accountId}\` |`,
    `| **Network** | testnet |`,
    `| **WASM** | \`${path.basename(wasmPath)}\` |`,
    `| **Faucet** | ${faucetAmount} NEAR |`,
    txHash ? `| **Tx Hash** | [\`${txHash.slice(0, 12)}…\`](${explorerUrl}) |` : '',
    `| **Tests** | ${testsPassed ? '✅ Passed' : '❌ Failed'} |`,
    '',
    `🔗 [View on Explorer](${explorerUrl})`,
  ].filter(l => l !== undefined && !(l.startsWith('|') && l.includes('undefined'))).join('\n');

  core.info(summary);

  // Write to GitHub step summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }

  core.setOutput('deploy_status',   testsPassed ? 'success' : 'tests_failed');
  core.setOutput('account_id',      accountId);
  core.setOutput('network',         'testnet');

  core.endGroup();
}

// ─── Credential helpers ───────────────────────────────────────────────────────

function credentialsDir() {
  return path.join(process.env.HOME || '/root', '.near-credentials');
}

function normalisePublicKey(privateKey) {
  // Accept ed25519:<base58> private key and derive public key via near-sdk-js util,
  // or simply return a placeholder – near CLI handles key derivation internally.
  // For account creation we need the PUBLIC key.
  // We'll use near-api-js if available, otherwise shell out.
  try {
    const { KeyPair } = require('near-api-js').utils; // may not be installed yet
    const kp = KeyPair.fromString(privateKey.startsWith('ed25519:') ? privateKey : `ed25519:${privateKey}`);
    return kp.getPublicKey().toString();
  } catch {
    // near-api-js not available – try to extract from near-cli credential files or derive manually
    // As a safe fallback we shell out:
    try {
      const node = process.execPath;
      const script = `
        const { KeyPair } = require('near-api-js').utils;
        const kp = KeyPair.fromString(process.argv[