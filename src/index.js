async function checkOrCreateAccount(accountId, privateKey, network) {
  core.startGroup('Step 1: Check / Create Testnet Account');
  core.info(`Checking if account "${accountId}" exists on ${network}...`);

  let accountExists = false;

  try {
    const response = await nearRpcCall(network, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });

    if (response.body && response.body.result && response.body.result.code_hash) {
      core.info(`✅ Account "${accountId}" already exists.`);
      core.info(`   Balance: ${(BigInt(response.body.result.amount) / BigInt('1000000000000000000000000')).toString()} NEAR`);
      accountExists = true;
    } else if (response.body && response.body.error) {
      const errName = response.body.error.cause ? response.body.error.cause.name : '';
      if (errName === 'UNKNOWN_ACCOUNT' || response.body.error.name === 'HANDLER_ERROR') {
        core.info(`Account "${accountId}" does not exist. Will attempt to create it via wallet API.`);
        accountExists = false;
      } else {
        core.warning(`Unexpected RPC error: ${JSON.stringify(response.body.error)}`);
        accountExists = false;
      }
    }
  } catch (err) {
    core.warning(`RPC check failed: ${err.message}. Assuming account does not exist.`);
    accountExists = false;
  }

  if (!accountExists) {
    core.info(`Attempting to create testnet account "${accountId}"...`);

    // Derive public key from private key using near-cli or key derivation
    let publicKey;
    try {
      // Try using near-cli keypair derivation
      const keyResult = execCommand(`node -e "
        const { KeyPair } = require('near-api-js');
        const keyPair = KeyPair.fromString('${privateKey}');
        console.log(keyPair.getPublicKey().toString());
      "`);

      if (keyResult.success) {
        publicKey = keyResult.output.trim();
        core.info(`Derived public key: ${publicKey}`);
      }
    } catch {
      core.warning('Could not derive public key from near-api-js, trying alternative...');
    }

    if (!publicKey) {
      // Fallback: use ed25519 derivation if key starts with ed25519:
      if (privateKey.startsWith('ed25519:')) {
        const rawKey = privateKey.replace('ed25519:', '');
        publicKey = `ed25519:${rawKey.substring(0, 44)}`; // approximation for logging
      } else {
        publicKey = privateKey; // last resort
      }
    }

    // Use testnet helper API to create account
    const helperBody = JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: publicKey,
    });

    try {
      const createResponse = await httpsRequest({
        hostname: 'helper.testnet.near.org',
        port: 443,
        path: '/account',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(helperBody),
          'Referer': 'https://wallet.testnet.near.org',
        },
      }, helperBody);

      if (createResponse.statusCode === 200 || createResponse.statusCode === 201) {
        core.info(`✅ Account "${accountId}" created successfully via testnet helper.`);
        accountExists = true;
      } else {
        core.warning(`Testnet helper response (${createResponse.statusCode}): ${JSON.stringify(createResponse.body)}`);
        // Account might already exist or creation failed; proceed anyway
        core.info('Proceeding — account may have been created or already exists.');
        accountExists = true; // optimistically proceed
      }
    } catch (helperErr) {
      core.warning(`Testnet helper request failed: ${helperErr.message}`);
      core.info('Proceeding — will attempt deployment regardless.');
      accountExists = true;
    }
  }

  core.endGroup();
  return { accountExists, accountId };
}

// ─── Step 2: Request Faucet Funding ──────────────────────────────────────────

async function requestFaucetFunding(accountId, faucetAmount, network) {
  core.startGroup('Step 2: Request Faucet Funding');
  core.info(`Requesting ${faucetAmount} NEAR for "${accountId}" on ${network}...`);

  let funded = false;
  let balanceBefore = BigInt(0);
  let balanceAfter = BigInt(0);

  // Check current balance
  try {
    const balanceResp = await nearRpcCall(network, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });

    if (balanceResp.body && balanceResp.body.result) {
      balanceBefore = BigInt(balanceResp.body.result.amount);
      const balanceNEAR = Number(balanceBefore / BigInt('1000000000000000000000000'));
      core.info(`Current balance: ~${balanceNEAR} NEAR`);

      if (balanceNEAR >= parseInt(faucetAmount, 10) / 2) {
        core.info(`Balance sufficient (${balanceNEAR} NEAR ≥ ${parseInt(faucetAmount, 10) / 2} NEAR). Skipping faucet.`);
        funded = true;
        core.endGroup();
        return { funded, balanceBefore: balanceNEAR, balanceAfter: balanceNEAR };
      }
    }
  } catch (err) {
    core.warning(`Balance check failed: ${err.message}`);
  }

  // Attempt faucet via testnet helper
  const faucetBody = JSON.stringify({ account_id: accountId });

  try {
    const faucetResp = await httpsRequest({
      hostname: 'helper.testnet.near.org',
      port: 443,
      path: '/faucet/tokens',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(faucetBody),
      },
    }, faucetBody);

    core.info(`Faucet response (${faucetResp.statusCode}): ${JSON.stringify(faucetResp.body)}`);

    if (faucetResp.statusCode === 200 || faucetResp.statusCode === 201) {
      core.info('✅ Faucet request successful.');
      funded = true;
    } else {
      core.warning(`Faucet returned ${faucetResp.statusCode}. Trying alternative faucet endpoint...`);
    }
  } catch (err) {
    core.warning(`Primary faucet failed: ${err.message}`);
  }

  // Alternative: try near-faucet.io or other community faucets
  if (!funded) {
    try {
      const altBody = JSON.stringify({ accountId, amount: faucetAmount });
      const altResp = await httpsRequest({
        hostname: 'near-faucet.io',
        port: 443,
        path: '/api/faucet',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(altBody),
        },
      }, altBody);

      core.info(`Alternative faucet response (${altResp.statusCode}): ${JSON.stringify(altResp.body)}`);
      if (altResp.statusCode === 200) {
        core.info('✅ Alternative faucet request successful.');
        funded = true;
      }
    } catch (altErr) {
      core.warning(`Alternative faucet failed: ${altErr.message}`);
    }
  }

  // Wait a moment then check new balance
  if (funded) {
    core.info('Waiting 5s for balance to update...');
    await new Promise(r => setTimeout(r, 5000));

    try {
      const newBalResp = await nearRpcCall(network, 'query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
      if (newBalResp.body && newBalResp.body.result) {
        balanceAfter = BigInt(newBalResp.body.result.amount);
        const afterNEAR = Number(balanceAfter / BigInt('1000000000000000000000000'));
        core.info(`New balance: ~${afterNEAR} NEAR`);
      }
    } catch {
      // non-critical
    }
  } else {
    core.warning('All faucet attempts failed. Continuing — account may already have sufficient funds.');
    funded = true; // proceed optimistically
  }

  const beforeNEAR = Number(balanceBefore / BigInt('1000000000000000000000000'));
  const afterNEAR = Number(balanceAfter / BigInt('1000000000000000000000000'));

  core.endGroup();
  return { funded, balanceBefore: beforeNEAR, balanceAfter: afterNEAR };
}

// ─── Step 3: Build & Deploy Contract ─────────────────────────────────────────

async function buildAndDeployContract(contractPath, accountId, privateKey, network) {
  core.startGroup('Step 3: Build & Deploy Contract');

  const resolvedPath = path.resolve(contractPath);
  core.info(`Contract path: ${resolvedPath}`);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Contract path does not exist: ${resolvedPath}`);
  }

  // ── 3a. Install near-cli if not present ──────────────────────────────────
  core.info('Checking for near-cli...');
  const nearCliCheck = execCommand('near --version');
  if (!nearCliCheck.success) {
    core.info('near-cli not found. Installing...');
    const installResult = execCommand('npm install -g near-cli');
    if (!installResult.success) {
      throw new Error(`Failed to install near-cli: ${installResult.error}`);
    }
    core.info('✅ near-cli installed.');
  } else {
    core.info(`✅ near-cli found: ${nearCliCheck.output}`);
  }

  // ── 3b. Detect contract type and build ───────────────────────────────────
  const isDirectory = fs.statSync(resolvedPath).isDirectory();
  let wasmPath = null;

  if (isDirectory) {
    const files = fs.readdirSync(resolvedPath);
    core.info(`Directory contents: ${files.join(', ')}`);

    const hasCargoToml = files.includes('Cargo.toml');
    const hasPackageJson = files.includes('package.json');

    if (hasCargoToml) {
      // Rust / WASM contract
      core.info('Detected Rust contract. Building with cargo...');

      // Ensure rust wasm target
      const rustupResult = execCommand('rustup target add wasm32-unknown-unknown');
      if (!rustupResult.success) {
        core.warning(`rustup target add failed: ${rustupResult.error}`);
      }

      // Try cargo-near first
      const cargoNearCheck = execCommand('cargo near --version');
      if (cargoNearCheck.success) {
        core.info('Using cargo-near to build...');
        const buildResult = await execCommandAsync('cargo near build --no-docker', { cwd: resolvedPath });
        if (!buildResult.success) {
          core.warning(`cargo-near build failed: ${buildResult.error}. Falling back to cargo build...`);
        } else {
          core.info('✅ cargo-near build succeeded.');
        }
      }

      // Standard cargo build
      const cargoBuild = await execCommandAsync(
        'cargo build --target wasm32-unknown-unknown --release',
        { cwd: resolvedPath }
      );

      if (!cargoBuild.success) {
        throw new Error(`Rust build failed:\n${cargoBuild.error}`);
      }

      // Find the built wasm
      const wasmDir = path.join(resolvedPath, 'target', 'wasm32-unknown-unknown', 'release');
      if (fs.existsSync(wasmDir)) {
        const wasmFiles = fs.readdirSync(wasmDir).filter(f => f.endsWith('.wasm'));
        if (wasmFiles.length > 0) {
          wasmPath = path.join(wasmDir, wasmFiles[0]);
          core.info(`Found WASM: ${wasmPath} (${(fs.statSync(wasmPath).size / 1024).toFixed(1)} KB)`);
        }
      }

      // Also check res/ folder (common pattern)
      const resDir = path.join(resolvedPath, 'res');
      if (!wasmPath && fs.existsSync(resDir)) {
        const resWasms = fs.readdirSync(resDir).filter(f => f.endsWith('.wasm'));
        if (resWasms.length > 0) {
          wasmPath = path.join(resDir, resWasms[0]);
          core.info(`Found WASM in res/: ${wasmPath}`);
        }
      }

      if (!wasmPath) {
        throw new Error('Build completed but no .wasm file found in expected locations.');
      }

    } else if (hasPackageJson) {
      // JS/TS contract (AssemblyScript or near-sdk-js)
      core.info('Detected JS/TS contract. Installing dependencies...');

      const npmInstall = await execCommandAsync('npm install', { cwd: resolvedPath });
      if (!npmInstall.success) {
        throw new Error(`npm install failed:\n${npmInstall.error}`);
      }

      // Check for build script
      const pkgJson = JSON.parse(fs.readFileSync(path.join(resolvedPath, 'package.json'), 'utf8'));
      const buildScript = pkgJson.scripts && (pkgJson.scripts.build || pkgJson.scripts['build:contract']);

      if (buildScript) {
        core.info(`Running build script: ${buildScript}`);
        const buildResult = await execCommandAsync('npm run build', { cwd: resolvedPath });
        if (!buildResult.success) {
          throw new Error(`npm build failed:\n${buildResult.error}`);
        }
      }

      // Find wasm output
      const searchDirs = ['build', 'out', 'res', 'target', '.'];
      for (const dir of searchDirs) {
        const searchDir = path.join(resolvedPath, dir);
        if (fs.existsSync(searchDir)) {
          const wasmFiles = fs.readdirSync(searchDir).filter(f => f.endsWith('.wasm'));
          if (wasmFiles.length > 0) {
            wasmPath = path.join(searchDir, wasmFiles[0]);
            core.info(`Found WASM: ${wasmPath}`);
            break;
          }
        }
      }

      if (!wasmPath) {
        throw new Error('No .wasm file found after build. Check your build configuration.');
      }
    } else {
      // Look for pre-built wasm in the directory
      core.info('Looking for pre-built .wasm file in directory...');
      const wasmFiles = files.filter(f => f.endsWith('.wasm'));
      if (wasmFiles.length > 0) {
        wasmPath = path.join(resolvedPath, wasmFiles[0]);
        core.info(`Found pre-built WASM: ${wasmPath}`);
      } else {
        throw new Error(`No supported contract format detected in ${resolvedPath}. Expected Cargo.toml, package.json, or .wasm file.`);
      }
    }
  } else {
    // Direct file path
    if (resolvedPath.endsWith('.wasm')) {
      wasmPath = resolvedPath;
      core.info(`Using pre-built WASM: ${wasmPath}`);
    } else {
      throw new Error(`Unsupported file type: ${resolvedPath}. Expected .wasm file or contract directory.`);
    }
  }

  core.info(`WASM size: ${(fs.statSync(wasmPath).size / 1024).toFixed(2)} KB`);

  // ── 3c. Set up credentials ───────────────────────────────────────────────
  core.info('Setting up NEAR credentials...');
  const credentialsDir = path.join(process.env.HOME || '/root', '.near-credentials', network);
  fs.mkdirSync(credentialsDir, { recursive: true });

  // Derive public key
  let publicKey = '';
  try {
    const keyDerive = execCommand(`node -e "
const { KeyPair } = require('near-api-js');
try {
  const kp = KeyPair.fromString(process.argv[1]);
  console.log(kp.getPublicKey().toString());
} catch(e) { process.exit(1); }
" "${privateKey}"`);

    if (keyDerive.success) {
      publicKey = keyDerive.output.trim();
    }
  } catch {
    // fallback
  }

  if (!publicKey) {
    // Try to extract from the key directly (ed25519 keys)
    if (privateKey.includes(':')) {
      const parts = privateKey.split(':');
      publicKey = `ed25519:${parts[1] ? parts[1].substring(0, 44) : parts[0]}`;
    } else {
      publicKey = `ed25519:${privateKey.substring(0, 44)}`;
    }
  }

  const credentials = {
    account_id: accountId,
    public_key: publicKey,
    private_key: privateKey,
  };

  const credFile = path.join(credentialsDir, `${accountId}.json`);
  fs.writeFileSync(credFile, JSON.stringify(credentials, null, 2));
  core.info(`✅ Credentials written to ${credFile}`);

  // ── 3d. Deploy via near-cli ──────────────────────────────────────────────
  core.info(`Deploying ${wasmPath} to ${accountId} on ${network}...`);

  const deployCmd = [
    'near deploy',
    `--accountId ${accountId}`,
    `--wasmFile "${wasmPath}"`,
    `--networkId ${network}`,
    `--keyPath "${credFile}"`,
    '--force',
  ].join(' ');

  const deployResult = await execCommandAsync(deployCmd);

  if (!deployResult.success) {
    // Try with environment variable approach
    core.warning(`near deploy failed: ${deployResult.error}`);
    core.info('Retrying with NEAR_ENV environment variable...');

    const deployResult2 = await execCommandAsync(
      `near deploy --accountId ${accountId} --wasmFile "${wasmPath}" --force`,
      {
        env: {
          ...process.env,
          NEAR_ENV: network,
          NEAR_CREDENTIALS_DIR: path.join(process.env.HOME || '/root', '.near-credentials'),
        }
      }
    );

    if (!deployResult2.success) {
      throw new Error(`Deployment failed:\n${deployResult2.error || deployResult2.output}`);
    }
  }

  core.info('✅ Contract deployed successfully!');

  // ── 3e. Verify deployment ────────────────────────────────────────────────
  core.info('Verifying deployment on-chain...');
  await new Promise(r => setTimeout(r, 3000));

  let codeHash = 'unknown';
  try {
    const verifyRe