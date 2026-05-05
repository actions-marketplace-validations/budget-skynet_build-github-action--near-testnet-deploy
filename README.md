# NEAR Testnet Deploy

GitHub Action for deploying smart contracts to NEAR testnet with automatic account creation, faucet funding, and smoke test execution.

## Description

Handles the complete NEAR testnet deployment workflow in a single step. Automatically creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | No | — | Account private key; auto-generated if omitted |
| `faucet-amount` | No | `10` | Amount of NEAR to request from faucet |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call after deploy |
| `network` | No | `testnet` | NEAR network RPC target |

## Outputs

| Output | Description |
|---|---|
| `account-id` | The testnet account used for deployment |
| `contract-hash` | SHA256 hash of the deployed contract |
| `transaction-id` | Deploy transaction ID on testnet |
| `smoke-test-results` | JSON string containing smoke test call results |
| `funded` | `true` if faucet funding was requested |

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
          private-key: ${{ secrets.NEAR_PRIVATE_KEY }}
          smoke-test-methods: get_status,get_owner

      - name: Print results
        run: |
          echo "Deployed to ${{ steps.deploy.outputs.account-id }}"
          echo "TX: ${{ steps.deploy.outputs.transaction-id }}"
