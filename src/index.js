async function nearRpcCall(method, params) {
  const body = {
    jsonrpc: '2.0',
    id: 'dontcare',
    method,
    params,
  };
  const payload = JSON.stringify(body);
  const options = {
    hostname: 'rpc.testnet.near.org',
    port: 443,
    path: '/',
    method: 'POST',
    protocol: 'https:',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };
  const response = await httpRequest(options, payload);
  if (response.body && response.body.error) {
    throw new Error(`RPC error: ${JSON.stringify(response.body.error)}`);
  }
  return response.body;
}

async function faucetRequest(accountId, amount) {
  // NEAR testnet helper contract faucet
  const body = JSON.stringify({ account_id: accountId, amount });
  const options = {
    hostname: 'helper.testnet.near.org',
    port: 443,
    path: '/account',
    method: 'POST',
    protocol: 'https:',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  return httpRequest(options, body);
}

async function nearWalletFaucet(accountId) {
  // Testnet faucet via near-faucet.io
  const body = JSON.stringify({ account: accountId });
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const options = {
    hostname: 'near-faucet.io',
    port: 443,
    path: '/api/faucet',
    method: 'POST',
    protocol: 'https:',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };
  return httpRequest(options, payload);
}

// ─── Shell Helper ────────────────────────────────────────────────────────────

function runCommand(cmd, options = {}) {
  core.info(`  $ ${cmd}`);
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      cwd: options.cwd || process.cwd(),
      timeout: options.timeout || 300000, // 5 min default
    });
    if (output) core.info(output.trim());
    return { success: true, output: output || '' };
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    if (options.allowFailure) {
      return { success: false, output: stdout, error: stderr, code: err.status };
    }
    throw new Error(`Command failed: ${cmd}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
  }
}

function runCommandAsync(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    core.info(`  $ ${cmd}`);
    const child = exec(cmd, {
      encoding: 'utf8',
      env: { ...process.env, ...options.env },
      cwd: options.cwd || process.cwd(),
      timeout: options.timeout || 300000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ success: code === 0, output: stdout, error: stderr, code });
      } else {
        reject(new Error(`Command failed (exit ${code}): ${cmd}\n${stderr}`));
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Step 1: Auto-Create Testnet Account ────────────────────────────────────

async function stepCreateAccount(accountId, privateKey, autoCreate) {
  core.startGroup('Step 1: Account Setup');
  core.info(`Checking account: ${accountId}`);

  let accountExists = false;

  try {
    const result = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    if (result && result.result && result.result.code_hash !== undefined) {
      accountExists = true;
      core.info(`✅ Account ${accountId} exists.`);
      core.info(`   Balance: ${result.result.amount} yoctoNEAR`);
    }
  } catch (err) {
    if (err.message.includes('does not exist') || err.message.includes('UNKNOWN_ACCOUNT')) {
      accountExists = false;
    } else {
      // RPC might return error object inline
      accountExists = false;
    }
  }

  // Double-check via RPC response structure
  if (!accountExists) {
    try {
      const res = await nearRpcCall('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      // If no error key and result exists
      if (res && res.result) {
        accountExists = true;
        core.info(`✅ Account ${accountId} confirmed via secondary check.`);
      }
    } catch {
      // truly doesn't exist
    }
  }

  if (!accountExists) {
    if (!autoCreate) {
      throw new Error(
        `Account ${accountId} does not exist and auto_create_account is disabled.`
      );
    }
    core.info(`Account ${accountId} not found. Creating via testnet helper...`);

    // Derive public key from private key using near-cli or key generation
    let publicKey;
    try {
      // Try using near-cli if installed
      const keyResult = runCommand(
        `node -e "
          const { KeyPair } = require('near-api-js');
          const keyPair = KeyPair.fromString('${privateKey}');
          console.log(keyPair.getPublicKey().toString());
        "`,
        { allowFailure: true }
      );
      if (keyResult.success) {
        publicKey = keyResult.output.trim();
      }
    } catch {
      // fallback: try to parse ed25519 key manually
    }

    if (!publicKey) {
      // Extract public key from private key string
      // NEAR private keys are in format ed25519:base58_private_key
      const keyStr = privateKey.replace('ed25519:', '');
      try {
        const { execSync: es } = require('child_process');
        const pubKeyOutput = es(
          `node -e "
            try {
              const bs58 = require('bs58');
              const nacl = require('tweetnacl');
              const privBytes = bs58.decode('${keyStr}');
              const seed = privBytes.slice(0, 32);
              const kp = nacl.sign.keyPair.fromSeed(seed);
              const pub = bs58.encode(Buffer.from(kp.publicKey));
              console.log('ed25519:' + pub);
            } catch(e) {
              console.error(e.message);
              process.exit(1);
            }
          "`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        publicKey = pubKeyOutput.trim();
      } catch {
        throw new Error(
          'Could not derive public key from private key. Ensure near-api-js or bs58/tweetnacl are available.'
        );
      }
    }

    core.info(`Derived public key: ${publicKey}`);

    // Create account via NEAR testnet helper
    const createBody = JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: publicKey,
    });
    const createOptions = {
      hostname: 'helper.testnet.near.org',
      port: 443,
      path: '/account',
      method: 'POST',
      protocol: 'https:',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(createBody),
      },
    };
    const createResponse = await httpRequest(createOptions, createBody);
    core.info(`Helper response status: ${createResponse.status}`);

    if (createResponse.status === 200 || createResponse.status === 201) {
      core.info(`✅ Account ${accountId} created successfully.`);
      // Wait for account to be finalized on chain
      await sleep(3000);
    } else {
      // Some helpers return 403 if account already exists or invalid
      core.warning(
        `Helper returned status ${createResponse.status}: ${createResponse.raw}`
      );
      // Verify account exists now despite unexpected status
      await sleep(5000);
      try {
        const verifyRes = await nearRpcCall('query', {
          request_type: 'view_account',
          finality: 'final',
          account_id: accountId,
        });
        if (verifyRes && verifyRes.result) {
          core.info(`✅ Account ${accountId} verified on chain despite helper response.`);
          accountExists = true;
        } else {
          throw new Error(`Account creation failed. Helper status: ${createResponse.status}`);
        }
      } catch {
        throw new Error(`Account creation failed. Helper status: ${createResponse.status}. Response: ${createResponse.raw}`);
      }
    }
  }

  core.endGroup();
  return { accountId, accountExists: true };
}

// ─── Step 2: Request Faucet Funding ─────────────────────────────────────────

async function stepFaucetFunding(accountId, fundingAmount) {
  core.startGroup('Step 2: Faucet Funding');
  core.info(`Requesting ${fundingAmount} NEAR from faucet for ${accountId}`);

  // Check current balance first
  let balanceBefore = '0';
  try {
    const balRes = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    if (balRes && balRes.result) {
      balanceBefore = balRes.result.amount || '0';
      const nearBalance = parseFloat(balanceBefore) / 1e24;
      core.info(`Current balance: ${nearBalance.toFixed(4)} NEAR`);

      // If balance is already sufficient (> 5 NEAR), skip faucet
      if (nearBalance > 5) {
        core.info(`✅ Balance sufficient, skipping faucet request.`);
        core.endGroup();
        return { funded: true, balanceBefore, balanceAfter: balanceBefore, skipped: true };
      }
    }
  } catch (err) {
    core.warning(`Could not check initial balance: ${err.message}`);
  }

  let fundingSuccess = false;
  const fundingAttempts = [
    async () => {
      core.info('Attempt 1: NEAR testnet helper faucet...');
      const amountInYocto = (parseFloat(fundingAmount) * 1e24).toString();
      const res = await faucetRequest(accountId, amountInYocto);
      core.info(`Faucet response: ${res.status} ${res.raw}`);
      return res.status === 200 || res.status === 201;
    },
    async () => {
      core.info('Attempt 2: near-faucet.io...');
      const res = await nearWalletFaucet(accountId);
      core.info(`near-faucet.io response: ${res.status} ${res.raw}`);
      return res.status === 200 || res.status === 201;
    },
    async () => {
      core.info('Attempt 3: Faucet via NEAR CLI transfer from top-level account...');
      // This uses the testnet helper to fund via near dev-deploy pattern
      const helperBody = JSON.stringify({ account_id: accountId });
      const opts = {
        hostname: 'helper.testnet.near.org',
        port: 443,
        path: '/account/fund',
        method: 'POST',
        protocol: 'https:',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(helperBody),
        },
      };
      const res = await httpRequest(opts, helperBody);
      core.info(`Helper fund response: ${res.status} ${res.raw}`);
      return res.status === 200 || res.status === 201;
    },
  ];

  for (const attempt of fundingAttempts) {
    try {
      fundingSuccess = await attempt();
      if (fundingSuccess) break;
    } catch (err) {
      core.warning(`Faucet attempt failed: ${err.message}`);
    }
    await sleep(2000);
  }

  if (!fundingSuccess) {
    core.warning('All faucet attempts failed. Proceeding with existing balance.');
  }

  // Wait for funding to land on chain
  await sleep(5000);

  let balanceAfter = balanceBefore;
  try {
    const balRes = await nearRpcCall('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    if (balRes && balRes.result) {
      balanceAfter = balRes.result.amount || '0';
      const nearBalance = parseFloat(balanceAfter) / 1e24;
      core.info(`Balance after funding: ${nearBalance.toFixed(4)} NEAR`);
    }
  } catch (err) {
    core.warning(`Could not check post-funding balance: ${err.message}`);
  }

  core.setOutput('balance_after_funding', balanceAfter);
  core.info(`✅ Faucet step complete.`);
  core.endGroup();

  return { funded: fundingSuccess, balanceBefore, balanceAfter };
}

// ─── Step 3: Build & Deploy Contract ────────────────────────────────────────

async function stepDeploy(contractPath, accountId, privateKey) {
  core.startGroup('Step 3: Build & Deploy Contract');

  const absoluteContractPath = path.resolve(contractPath);
  core.info(`Contract path: ${absoluteContractPath}`);

  if (!fs.existsSync(absoluteContractPath)) {
    throw new Error(`Contract path does not exist: ${absoluteContractPath}`);
  }

  let wasmPath = null;

  // Determine if it's a WASM file or a directory to build
  const stat = fs.statSync(absoluteContractPath);

  if (stat.isFile() && absoluteContractPath.endsWith('.wasm')) {
    core.info('Contract is a pre-compiled WASM file. Skipping build.');
    wasmPath = absoluteContractPath;
  } else if (stat.isDirectory()) {
    core.info('Contract is a directory. Attempting to build...');

    // Detect contract type
    const hasCargoToml = fs.existsSync(path.join(absoluteContractPath, 'Cargo.toml'));
    const hasPackageJson = fs.existsSync(path.join(absoluteContractPath, 'package.json'));
    const hasMakefile = fs.existsSync(path.join(absoluteContractPath, 'Makefile'));

    if (hasMakefile) {
      core.info('Found Makefile — running make build...');
      await runCommandAsync('make build', { cwd: absoluteContractPath, timeout: 600000 });
    } else if (hasCargoToml) {
      core.info('Detected Rust/WASM contract (Cargo.toml found).');

      // Check if cargo is available
      const cargoCheck = runCommand('cargo --version', { allowFailure: true });
      if (!cargoCheck.success) {
        throw new Error('cargo not found. Please add a build step to install Rust toolchain.');
      }

      // Install wasm32 target if needed
      runCommand('rustup target add wasm32-unknown-unknown', { allowFailure: true });

      // Check for cargo-near or use standard build
      const cargoNearCheck = runCommand('cargo near --version', { allowFailure: true });
      if (cargoNearCheck.success) {
        core.info('Using cargo-near for build...');
        await runCommandAsync('cargo near build', {
          cwd: absoluteContractPath,
          timeout: 600000,
        });
      } else {
        core.info('Using cargo build for wasm32...');
        await runCommandAsync(
          'cargo build --target wasm32-unknown-unknown --release',
          { cwd: absoluteContractPath, timeout: 600000 }
        );
      }

      // Locate the built WASM file
      const targetDir = path.join(absoluteContractPath, 'target');
      const wasmSearchDirs = [
        path.join(targetDir, 'wasm32-unknown-unknown', 'release'),
        path.join(targetDir, 'near'),
        path.join(absoluteContractPath, 'res'),
      ];

      for (const dir of wasmSearchDirs) {
        if (fs.existsSync(dir)) {
          const wasmFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.wasm'));
          if (wasmFiles.length > 0) {
            wasmPath = path.join(dir, wasmFiles[0]);
            core.info(`Found WASM: ${wasmPath}`);
            break;
          }
        }
      }

      if (!wasmPath) {
        // Recursive search fallback
        const findResult = runCommand(
          `find ${absoluteContractPath}/target -name "*.wasm" -not -path "*/deps/*" | head -1`,
          { allowFailure: true }
        );
        if (findResult.success && findResult.output.trim()) {
          wasmPath = findResult.output.trim();
        }
      }
    } else if (hasPackageJson) {
      core.info('Detected JS/TS contract (package.json found).');
      const pkg = JSON.parse(fs.readFileSync(path.join(absoluteContractPath, 'package.json'), 'utf8'));

      // Install deps
      const hasYarnLock = fs.existsSync(path.join(absoluteContractPath, 'yarn.lock'));
      const installCmd = hasYarnLock ? 'yarn install --frozen-lockfile' : 'npm ci';
      await runCommandAsync(installCmd, { cwd: absoluteContractPath, timeout: 300000 });

      // Build
      if (pkg.scripts && pkg.scripts.build) {
        await runCommandAsync('npm run build', { cwd: absoluteContractPath, timeout: 300000 });
      }

      // Find WASM
      const wasmSearchPaths = ['build', 'out', 'dist', '.'];
      for (const dir of wasmSearchPaths) {
        const fullDir = path.join(absoluteContractPath, dir);
        if (fs.existsSync(fullDir)) {
          const files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.wasm'));
          if (files.length > 0) {
            wasmPath = path.join(fullDir, files[0]);
            break;
          }
        }
      }
    } else {
      // Generic: look for any .wasm in the directory
      const findResult = runCommand(
        `find ${absoluteContractPath} -name "*.wasm" | head -1`,
        { allowFailure: true }
      );
      if (findResult.success && findResult.output.trim()) {
        wasmPath = findResult.output.trim();
        core.info(`Found pre-built WASM: ${wasmPath}`);
      }
    }

    if (!wasmPath) {
      throw new Error(
        `Could not find or build WASM file from contract directory: ${absoluteContractPath}`
      );
    }
  } else {
    throw new Error(`Contract path must be a .wasm file or a directory: ${absoluteContractPath}`);
  }

  core.info(`Deploying WASM: ${wasmPath}`);
  const wasmSize = fs.statSync(wasmPath).size;
  core.info(`WASM size: ${(wasmSize / 1024).toFixed(2)} KB`);

  // Read WASM bytes
  const wasmBytes = fs.readFileSync(wasmPath);
  const wasmBase64 = wasmBytes.toString('base64');

  // Set up NEAR credentials for near-cli
  const credentialsDir = path.join(process.env.HOME || '/root', '.near-credentials', 'testnet');
  fs.mkdirSync(credentialsDir, { recursive: true });

  const credFile = path.join(credentialsDir, `${accountId}.json`);
  const privateKeyStr = privateKey.startsWith('ed25519:') ? privateKey : `ed25519:${privateKey}`;

  // Derive public key
  let publicKeyStr = '';
  try {
    const pubRes = runCommand(
      `node -e "
        try {
          const nearApi = require('near-api-js');
          const kp = nearApi.KeyPair.fromString('${privateKeyStr}');
          console.log(kp.getPublicKey().toString());
        } catch(e) {
          process.exit(1);
        }
      "`,
      { allowFailure: true }
    );
    if (pubRes.success) {