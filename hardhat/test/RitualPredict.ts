import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

/** README reports ~195 ms measured on the live chain. */
const BLOCK_TIME_MS = 195n;

/** The Scheduler's documented MAX_LIFESPAN, per the contract comments. */
const SCHEDULER_MAX_LIFESPAN = 10_000n;

/**
 * Ritual system contract, hardcoded in contracts/ritual/RitualChain.sol and
 * plainly visible in the deployment bytecode. The constructor calls it, so on
 * a bare local chain the deployment reverts before any test can run.
 */
const SCHEDULER = "0x56e776bae2dd60664b69bd5f865f1180ffb7d58b";

/** Runtime code that is a single STOP: any call succeeds, returning no data. */
const ALWAYS_SUCCEEDS = "0x00";

/** Comparator enum: GT, GTE, LT, LTE. */
const COMPARATOR_GTE = 1;

const NEW_MARKET = {
  question: "Will ETH/USD be at least $4,000 when this market resolves?",
  oracleUrl: "https://example.invalid/api/oracle/eth",
  jsonPath: ".price",
  target: 4000n,
  comparator: COMPARATOR_GTE,
  bettingSeconds: 3600n,
  resolveDelaySeconds: 600n,
} as const;

describe("RitualPredict", function () {
  describe("on a bare local chain", async function () {
    const { viem } = await network.create();

    it("cannot be deployed at all, because the constructor calls the Scheduler", async function () {
      await assert.rejects(viem.deployContract("RitualPredict", [BLOCK_TIME_MS]));
    });
  });

  describe("with the Scheduler stubbed out", async function () {
    const { viem, provider } = await network.create();

    // Give the Scheduler address some code so the constructor's call succeeds.
    await provider.request({
      method: "hardhat_setCode",
      params: [SCHEDULER, ALWAYS_SUCCEEDS],
    });

    async function deploy() {
      return await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
    }

    it("deploys once the Scheduler address has code", async function () {
      const predict = await deploy();
      assert.notEqual(predict.address, undefined);
    });

    it("stores the block time given at construction", async function () {
      const predict = await deploy();
      assert.equal(await predict.read.blockTimeMs(), BLOCK_TIME_MS);
    });

    it("starts with zero markets", async function () {
      const predict = await deploy();
      assert.equal(await predict.read.marketCount(), 0n);
    });

    it("exposes the documented retry policy", async function () {
      const predict = await deploy();

      assert.equal(Number(await predict.read.MAX_ATTEMPTS()), 3);
      assert.equal(Number(await predict.read.RETRY_INTERVAL_BLOCKS()), 200);
      assert.equal(Number(await predict.read.RESOLVE_GAS_LIMIT()), 2_000_000);
    });

    it("books a schedule that fits inside the Scheduler's MAX_LIFESPAN", async function () {
      const predict = await deploy();

      const attempts = BigInt(await predict.read.MAX_ATTEMPTS());
      const interval = BigInt(await predict.read.RETRY_INTERVAL_BLOCKS());

      assert.ok(
        attempts * interval < SCHEDULER_MAX_LIFESPAN,
        `attempts * interval = ${attempts * interval}, must be < ${SCHEDULER_MAX_LIFESPAN}`,
      );
    });

    it("keeps the market duration bounds internally consistent", async function () {
      const predict = await deploy();

      const minBetting = BigInt(await predict.read.MIN_BETTING_SECONDS());
      const minResolveDelay = BigInt(await predict.read.MIN_RESOLVE_DELAY_SECONDS());
      const maxMarket = BigInt(await predict.read.MAX_MARKET_SECONDS());

      assert.ok(minBetting > 0n, "MIN_BETTING_SECONDS must be positive");
      assert.ok(minResolveDelay > 0n, "MIN_RESOLVE_DELAY_SECONDS must be positive");
      assert.ok(
        minBetting + minResolveDelay < maxMarket,
        "the shortest legal market must still fit under MAX_MARKET_SECONDS",
      );
    });

    /**
     * Characterisation test, not a wish.
     *
     * createMarket accepts a well-formed NewMarket, does not revert, and yet
     * records nothing: marketCount stays 0 and getMarkets stays empty. The
     * deployed bytecode agrees — the createMarket entry decodes its 224-byte
     * struct argument, discards it, and returns 0. The Scheduler address also
     * appears only in the constructor, never in the runtime code, so no
     * schedule can possibly be booked.
     *
     * In other words, the shipped contract leaves market creation
     * unimplemented. This test pins that down so any future implementation
     * fails loudly here.
     */
    it("accepts createMarket but silently records nothing", async function () {
      const predict = await deploy();

      await predict.write.createMarket([NEW_MARKET]);

      assert.equal(await predict.read.marketCount(), 0n);
      assert.deepEqual(await predict.read.getMarkets(), []);
    });

    it("rejects a bet, because no market can ever exist", async function () {
      const predict = await deploy();

      await predict.write.createMarket([NEW_MARKET]);

      await assert.rejects(
        predict.write.bet([1n, true], { value: 10_000_000_000_000_000n }),
      );
    });
  });
});