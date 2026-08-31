# Local Run Notes — Ritual Predict (Bootcamp 2)

Environment: Windows 11, Node v26.3.1, pnpm 11.24.0, Hardhat 3.13.0,
solc 0.8.28 (evm target: cancun)

The Ritual testnet was unreachable for the whole of my attempt, so this is a
record of getting the project running locally, and of what I found once it did.

## Setup problems and fixes

1. `npm install` failed with `ENOENT ... package.json`.
   The Hardhat project is not at the repo root; it lives in `hardhat/`.
   Fix: `cd hardhat` first. Same cause for `HHE3: No Hardhat config file found`.

2. `npx hardhat compile` then failed with `could not determine executable to
   run`. I had installed the pnpm CLI but never the project dependencies.
   Fix: run `pnpm install` before any hardhat command.

3. `pnpm install` aborted with `TimeoutError: The operation was aborted due to
   timeout` while downloading `@nomicfoundation/edr-*` binaries for every
   platform (~80 MB).
   Fix: raised `fetch-retries`, `fetch-retry-maxtimeout` and `fetch-timeout`,
   then retried; the pnpm cache resumed the partial download.

4. `ERR_PNPM_IGNORED_BUILDS: esbuild@0.28.2`. pnpm blocks postinstall scripts
   by default, but esbuild is needed to run this project's TypeScript.
   Fix: `pnpm approve-builds` and approve esbuild.

5. Every script stopped at `[hardhat-keystore] Enter the password:`, even with
   `--network hardhatMainnet`. The config resolves the Ritual account through
   `configVariable("DEPLOYER_PRIVATE_KEY")`, and the whole config is loaded up
   front, so the prompt appears regardless of the target network.
   Fix: supply `DEPLOYER_PRIVATE_KEY` as an environment variable, using the
   public Hardhat test account #0 rather than a real key.

6. `scripts/block-time.ts` failed with `connect ETIMEDOUT 162.255.119.231:443`
   against rpc.ritualfoundation.org. DNS resolved but the RPC never answered,
   confirming the testnet was down rather than a local misconfiguration. The
   script also ignores `--network` and opens the `ritual` connection directly,
   as do deploy.ts, fund.ts, create-demo-market.ts and status.ts.
   Conclusion: no script in `scripts/` can run offline. The only viable local
   path is Hardhat 3's in-memory network via `await network.create()`.

7. `pnpm hardhat test` failed with `HHE1000: Artifact for contract "Counter"
   not found`, even though compilation had succeeded. There is no `Counter.sol`
   anywhere in the repo, while `artifacts/contracts/RitualPredict.sol` exists.
   So `test/Counter.ts` is leftover Hardhat template scaffolding referencing a
   contract that was removed, and the repo's main contract had no coverage at
   all. Fix: delete the orphaned test and write real tests.

## Findings about the contract

8. RitualPredict cannot be deployed on a bare local chain at all. Every test
   failed with:

       Transaction reverted: function call to a non-contract account
       at RitualPredict.constructor (contracts/RitualPredict.sol:213)

   The constructor takes only `uint256 blockTimeMs`, which misled me into
   assuming it touched no Ritual infrastructure. It does: the deployment
   bytecode contains `PUSH20 0x56e776bae2dd60664b69bd5f865f1180ffb7d58b`
   followed by a CALL, i.e. the Scheduler system contract. On a local chain
   that address holds no code, so construction reverts.

9. Workaround that makes the contract testable offline: install trivial runtime
   code at the Scheduler address before deploying.

       await provider.request({
         method: "hardhat_setCode",
         params: [SCHEDULER, "0x00"],
       });

   `0x00` is a single STOP, so any call to that address succeeds and returns no
   data. That is enough to satisfy the constructor. Deployment then works and
   the contract's state and constants become testable with no RPC, no keystore
   and no funded account.

10. The retry policy is self-consistent with the Scheduler's documented
    MAX_LIFESPAN of 10,000 blocks:
    MAX_ATTEMPTS (3) * RETRY_INTERVAL_BLOCKS (200) = 600 < 10,000.
    RESOLVE_GAS_LIMIT is 2,000,000. All three are asserted in the tests.

11. The most significant finding: **createMarket is not implemented in the
    contract as shipped.** It accepts a well-formed `NewMarket`, does not
    revert, and records nothing at all: `marketCount` stays 0 and
    `getMarkets()` stays empty.

    The bytecode explains why. The `createMarket` dispatcher entry decodes its
    224-byte (7-field) struct argument, discards it with POP, and returns 0.
    Independently, the Scheduler address appears exactly once in the whole
    bytecode, inside the constructor, and never in the runtime code, so no
    resolution schedule can possibly be booked. A second dispatcher entry
    taking two uint256 arguments has an equally empty body, which matches
    `onScheduledResolve`.

    So the "self-resolving" half of this self-resolving prediction market is
    the part left to implement. The pari-mutuel accounting, refunds, payouts,
    HTTP/jq response decoding and the Ritual wallet funding path are all
    present; market creation and scheduled resolution are the seams.

12. Config gap I fixed: the repo defines only `hardhatMainnet` and `ritual`.
    There is no `localhost` network, so a standalone `hardhat node` cannot be
    targeted by any script. I added a `localhost` http network on port 8545.

## What I built

`test/RitualPredict.ts` — nine tests that run fully offline, in two groups.

    pnpm hardhat test
    9 passing

Group 1, on a bare local chain: asserts that deployment reverts, documenting
finding 8.

Group 2, with the Scheduler stubbed via `hardhat_setCode`: deployment,
stored blockTimeMs, initial marketCount, the retry policy constants, the
MAX_LIFESPAN invariant, and the internal consistency of the market duration
bounds.

The last two are characterisation tests rather than aspirational ones. They
assert that `createMarket` silently records nothing and that betting on the
market it should have created reverts. If anyone implements market creation,
those two tests fail loudly — which is exactly what I want them to do.
