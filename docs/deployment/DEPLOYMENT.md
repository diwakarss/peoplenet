# Deployment Guide

## Prerequisites
- Node.js 14+
- Hardhat
- Environment variables configured

## Deployment Steps

1. Deploy Diamond Infrastructure

bash
npx hardhat run scripts/deploy/00-deploy-diamond.js --network <network>

2. Deploy TokenFacet

npx hardhat run scripts/deploy/01-deploy-token-facet.js --network <network>

## Verification Steps
1. Verify diamond contract
2. Verify facets
3. Test basic functionality

## Network Specific Deployments
- Mainnet: [Addresses]
- Testnet: [Addresses]

## Upgrading
Instructions for upgrading facets...