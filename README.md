# NEAR Testnet Deploy

GitHub Action for deploying smart contracts to NEAR testnet with automatic account creation, faucet funding, and smoke test execution.

## Description

Handles the complete NEAR testnet deployment workflow in a single step. Automatically creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | No | — | Private key for existing account. Omit to auto-create |
| `run-smoke-tests` | No | `true` | Run basic smoke tests after deployment |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call |
| `network` | No | `testnet` | NEAR network to target |

## Outputs

| Name | Description |
|------|-------------|
| `account-id` | The testnet account ID used for deployment |
| `contract-hash` | SHA256 hash of the deployed contract |
| `transaction-id` | Deployment transaction ID |
| `smoke-test-results` | JSON string containing smoke test outcomes |
| `funded-amount` | Amount of NEAR received from faucet in yoctoNEAR |

## Usage

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build contract
        run: cargo build --target wasm32-unknown-unknown --release

      - name: Deploy to NEAR Testnet
        id: deploy
        uses: your-org/near-testnet-deploy@v1
        with:
          account-id: myapp.testnet
          contract-path: target/wasm32-unknown-unknown/release/contract.wasm
          run-smoke-tests: true
          smoke-test-methods: get_status,get_owner

      - name: Print results
        run: |
          echo "Deployed to: ${{ steps.deploy.outputs.account-id }}"
          echo "TX: ${{ steps.deploy.outputs.transaction-id }}"
