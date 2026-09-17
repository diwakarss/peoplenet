# PeopleNet UI

A minimal UI dashboard for interacting with PeopleNet's AAO contracts.

## Features

- Connect wallet (MetaMask)
- Create Macro and Micro AAOs
- View AAO details
- Join/leave AAOs
- Manage AAO membership
- Admin functions

## Getting Started

### Prerequisites

- Node.js (v14+)
- npm or yarn
- MetaMask browser extension

### Installation

1. Clone the repository
2. Navigate to the UI directory:
   ```
   cd ui
   ```
3. Install dependencies:
   ```
   npm install
   # or
   yarn
   ```
4. Create a `.env.local` file with your configuration:
   ```
   NEXT_PUBLIC_RPC_URL=https://sepolia.infura.io/v3/YOUR_INFURA_KEY
   NEXT_PUBLIC_CHAIN_ID=11155111
   NEXT_PUBLIC_DIAMOND_ADDRESS=0xYourDeployedDiamondAddress
   ```

### Development

Run the development server:

```bash
npm run dev
# or
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Project Structure

- `pages/` - Next.js pages
- `components/` - React components
- `hooks/` - Custom React hooks
- `contexts/` - React contexts
- `utils/` - Utility functions
- `abis/` - Contract ABIs
- `styles/` - CSS styles

## Deployment

The UI can be deployed to Vercel, Netlify, or any other static site hosting service.

```bash
npm run build
npm run export
```

## License

This project is licensed under the MIT License.

## The governance page

Separate from this Next.js dashboard, `governance/` holds a static one-page view
of AAO 0 for local governance: every proposal, its tally, who voted, and the
Director's vote / casting-vote / execute buttons. No wallet, no build step, no
framework -- ethers v6 from a CDN over a loopback static server.

```bash
npm run governance    # http://127.0.0.1:8787
```

The three roles and the tie rule are documented in
[`governance/README.md`](../governance/README.md).
