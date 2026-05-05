# NEAR Testnet Deploy

Automatically deploy smart contracts to NEAR testnet with account creation, faucet funding, and smoke test execution in a single step.

## Description

This action handles the complete NEAR testnet deployment workflow. It creates a testnet account if one does not exist, requests faucet funding, deploys your contract, runs basic smoke tests, and reports the results back to your workflow.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `account-id` | Yes | — | NEAR testnet account ID to deploy to |
| `contract-path` | Yes | — | Path to the compiled `.wasm` contract file |
| `private-key` | Yes | — | Private key for the testnet account |
| `faucet-amount` | No | `10` | Amount of NEAR to request from faucet |
| `smoke-test-methods` | No | — | Comma-separated list of view methods to call after deploy |
| `network` | No | `testnet` | NEAR network RPC endpoint alias |

## Outputs

| Name | Description |
|------|-------------|
| `account-id` | The testnet account used for deployment |
| `contract-hash` | Hash of the deployed contract |
| `transaction-id` | Deploy transaction ID |
| `smoke-test-status` | Result of smoke tests: `passed` or `failed` |
| `explorer-url` | Link to the transaction in NEAR Explorer |

## Usage

name: Deploy to Testnet

on:
  push:
    branches:
      - main

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
          contract-path: target/wasm32-unknown-unknown/release/contract.wasm
          private-key: ${{ secrets.NEAR_PRIVATE_KEY }}
          smoke-test-methods: get_status,get_owner

## License

MIT