# NEAR Testnet Deploy

GitHub Action for deploying smart contracts to NEAR testnet with automatic account creation, faucet funding, and smoke test execution.

## Description

Handles the complete NEAR testnet deployment workflow in a single step. Automatically creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports results.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `faucet-amount` | No | `10` | Amount of NEAR tokens to request from faucet |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call after deploy |
| `network` | No | `testnet` | NEAR network RPC target |

## Outputs

| Output | Description |
|--------|-------------|
| `account-id` | The testnet account used for deployment |
| `transaction-hash` | Deploy transaction hash |
| `contract-balance` | Account balance after faucet funding |
| `smoke-test-results` | JSON string of smoke test call results |
| `deployment-status` | `success` or `failure` |

## Usage

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build contract
        run: cargo build --target wasm32-unknown-unknown --release

      - name: Deploy to NEAR Testnet
        uses: your-org/near-testnet-deploy@v1
        with:
          account-id: mycontract.testnet
          contract-path: ./target/wasm32-unknown-unknown/release/contract.wasm
          private-key: ${{ secrets.NEAR_TESTNET_PRIVATE_KEY }}
          faucet-amount: 10
          smoke-test-methods: get_status,get_owner

## Notes

- Account creation is skipped if the account already exists on testnet
- Faucet requests are rate-limited by the NEAR testnet faucet service
- Smoke tests fail the workflow if any method call returns an error