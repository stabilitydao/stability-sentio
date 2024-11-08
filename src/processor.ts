import {FactoryProcessor, StrategyProcessorTemplate, VaultProcessorTemplate} from "./types/eth/index.js";
import {Vault} from "./types/eth/internal/index.js";
import {Pool, Strategy, UnderlyingType, VaultUser} from "./schema/store.js";
import {getStrategyContract} from "./types/eth/internal/strategy-processor.js";
import {getVaultContract, VaultBoundContractView} from "./types/eth/internal/vault-processor.js";
import {BlockParams} from 'ethers/providers'
import {BigDecimal, scaleDown} from "@sentio/sdk";
import {ContractContext, EthChainId} from "@sentio/sdk/eth";
import {token} from "@sentio/sdk/utils";
import {getPriceReaderContract} from "./types/eth/internal/pricereader-processor.js";

const deployments: {[chainId in EthChainId]?: {
  factory: string,
  priceReader: string,
}} = {
  [EthChainId.POLYGON]: {
    factory: "0xa14EaAE76890595B3C7ea308dAEBB93863480EAD",
    priceReader: "0xcCef9C4459d73F9A997ff50AC34364555A3274Aa",
  },
}

// IVault contracts
const vaultTemplate = new VaultProcessorTemplate()
  // vault symbol changed
  .onEventVaultSymbol(async (event, ctx) => {
    const vault = await ctx.store.get(Pool, event.address) as Pool
    vault.pool_symbol = event.args.newSymbol
    vault.receipt_token_symbol = event.args.newSymbol
    await ctx.store.upsert(vault)
  })
  // user deposit
  .onEventDepositAssets(async (event, ctx) => {
    const vault = await ctx.store.get(Pool, event.address) as Pool
    const tvl = await ctx.contract.tvl()
    const totalSupply = scaleDown(await ctx.contract.totalSupply(), 18)
    const vaultUnderlyingAmount = await getVaultUnderlyingAmount(vault, ctx.chainId, tvl[0])
    const mintAmount = scaleDown(event.args.mintAmount, 18)
    const userBalance = scaleDown(await ctx.contract.balanceOf(event.args.account), 18)
    const underlying_token_amount = userBalance.times(vaultUnderlyingAmount).div(totalSupply)
    const underlying_token_amount_usd = userBalance.times(scaleDown(tvl[0], 18)).div(totalSupply)

    let vaultUser = await ctx.store.get(VaultUser, event.args.account + '-' + event.address)
    if (!vaultUser) {
      vaultUser = new VaultUser({
        id: event.args.account + '-' + event.address,
        vault: event.address,
        account: event.args.account,
        earned: 0,
        earnedSnapshot: 0,
        underlying_token_amount: 0,
        underlying_token_amount_usd: 0,
      })
    }
    vaultUser.underlying_token_amount = underlying_token_amount.toNumber()
    vaultUser.underlying_token_amount_usd = underlying_token_amount_usd.toNumber()
    await ctx.store.upsert(vaultUser)

    ctx.eventLogger.emit('misc_events', {
      timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
      chain_id: ctx.chainId,
      block_number: event.blockNumber,
      log_index: event.index,
      transaction_hash: event.transactionHash,
      user_address: event.args.account,
      taker_address: event.args.account,
      pool_address: vault.pool_address,
      underlying_token_address: vault.underlying_token_address,
      amount: mintAmount,
      amount_usd: mintAmount.times(scaleDown(tvl[0], 18)).div(totalSupply),
      event_type: 'deposit',
    })

  })
  // user withdraw
  .onEventWithdrawAssets(async (event, ctx) => {
    const vault = await ctx.store.get(Pool, event.address) as Pool
    const tvl = await ctx.contract.tvl()
    const totalSupply = scaleDown(await ctx.contract.totalSupply(), 18)
    const vaultUnderlyingAmount = await getVaultUnderlyingAmount(vault, ctx.chainId, tvl[0])
    const burnAmount = scaleDown(event.args.sharesAmount, 18)
    const userBalance = scaleDown(await ctx.contract.balanceOf(event.args.owner), 18)
    const underlying_token_amount = userBalance.times(vaultUnderlyingAmount).div(totalSupply)
    const underlying_token_amount_usd = userBalance.times(scaleDown(tvl[0], 18)).div(totalSupply)

    const vaultUser = await ctx.store.get(VaultUser, event.args.owner + '-' + event.address) as VaultUser
    vaultUser.underlying_token_amount = underlying_token_amount.toNumber()
    vaultUser.underlying_token_amount_usd = underlying_token_amount_usd.toNumber()
    await ctx.store.upsert(vaultUser)

    ctx.eventLogger.emit('misc_events', {
      timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
      chain_id: ctx.chainId,
      block_number: event.blockNumber,
      log_index: event.index,
      transaction_hash: event.transactionHash,
      user_address: event.args.owner,
      taker_address: event.args.owner,
      pool_address: vault.pool_address,
      underlying_token_address: vault.underlying_token_address,
      amount: burnAmount,
      amount_usd: burnAmount.times(scaleDown(tvl[0], 18)).div(totalSupply.plus(burnAmount)),
      event_type: 'withdrawal',
    })

  })
  // user transfer
  .onEventTransfer(async (event, ctx) => {
    if (
      event.args.from !== "0x0000000000000000000000000000000000000000"
      && event.args.to !== "0x0000000000000000000000000000000000000000"
    ) {
      const vault = await ctx.store.get(Pool, event.address) as Pool
      const tvl = await ctx.contract.tvl()
      const totalSupply = scaleDown(await ctx.contract.totalSupply(), 18)
      const vaultUnderlyingAmount = await getVaultUnderlyingAmount(vault, ctx.chainId, tvl[0])
      const transferAmount = scaleDown(event.args.value, 18)

      const vaultUserFrom = await ctx.store.get(VaultUser, event.args.from + '-' + event.address) as VaultUser
      let vaultUserTo = await ctx.store.get(VaultUser, event.args.to + '-' + event.address)
      if (!vaultUserTo) {
        vaultUserTo = new VaultUser({
          id: event.args.to + '-' + event.address,
          vault: event.address,
          account: event.args.to,
          earned: 0,
          earnedSnapshot: 0,
          underlying_token_amount: 0,
          underlying_token_amount_usd: 0,
        })
      }
      const userBalanceFrom = scaleDown(await ctx.contract.balanceOf(event.args.from), 18)
      const userBalanceTo = scaleDown(await ctx.contract.balanceOf(event.args.to), 18)
      vaultUserFrom.underlying_token_amount = userBalanceFrom.times(vaultUnderlyingAmount).div(totalSupply).toNumber()
      vaultUserFrom.underlying_token_amount_usd = userBalanceFrom.times(scaleDown(tvl[0], 18)).div(totalSupply).toNumber()
      vaultUserTo.underlying_token_amount = userBalanceTo.times(vaultUnderlyingAmount).div(totalSupply).toNumber()
      vaultUserTo.underlying_token_amount_usd = userBalanceTo.times(scaleDown(tvl[0], 18)).div(totalSupply).toNumber()
      await ctx.store.upsert(vaultUserFrom)
      await ctx.store.upsert(vaultUserTo)

      ctx.eventLogger.emit('misc_events', {
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        chain_id: ctx.chainId,
        block_number: event.blockNumber,
        log_index: event.index,
        transaction_hash: event.transactionHash,
        user_address: event.args.from,
        taker_address: event.args.to,
        pool_address: vault.pool_address,
        underlying_token_address: vault.underlying_token_address,
        amount: transferAmount,
        amount_usd: transferAmount.times(scaleDown(tvl[0], 18)).div(totalSupply),
        event_type: 'transfer',
      })
    }

  })
  // regular snapshots
  .onTimeInterval(snapshots, 60 * 24, 60 * 24)

// IStrategy contracts
const strategyTemplate = new StrategyProcessorTemplate()
  .onEventHardWork(async (event, ctx) => {

    const strategy = await ctx.store.get(Strategy, event.address) as Strategy
    const vault = await ctx.store.get(Pool, strategy.vault) as Pool
    vault.earned += scaleDown(event.args.earned, 18).toNumber()
    await ctx.store.upsert(vault)

    const tvl = await getVaultContract(ctx.chainId, vault.pool_address).tvl()
    const vaultUnderlyingAmount = await getVaultUnderlyingAmount(vault, ctx.chainId, tvl[0])

    // add earned to all vault users
    // const vaultUsers: VaultUser[] = []
    for await (const vaultUser of ctx.store.listIterator(VaultUser, [{
      field: "vault",
      op: "=",
      value: vault.pool_address
    }])) {
      vaultUser.earned += vaultUser.underlying_token_amount * scaleDown(event.args.earned, 18).toNumber() / vaultUnderlyingAmount.toNumber()
      await ctx.store.upsert(vaultUser)
      // vaultUsers.push(vaultUser)
    }

  })

async function snapshots(block: BlockParams, ctx: ContractContext<Vault, VaultBoundContractView>) {
  await poolSnapshot(block, ctx)
  await positionSnapshot(block, ctx)
}

async function poolSnapshot(block: BlockParams, ctx: ContractContext<Vault, VaultBoundContractView>) {
  const pool = await ctx.store.get(Pool, ctx.contract.address) as Pool

  const tvl = await ctx.contract.tvl()
  const underlying_token_amount_usd = scaleDown(tvl[0], 18)
  let underlying_token_amount: BigDecimal
  if (pool.underlying_type === UnderlyingType.NATIVE) {
    const strategyContract = getStrategyContract(ctx.chainId, pool.strategy)
    underlying_token_amount = scaleDown(await strategyContract.total(), pool.underlying_token_decimals)
  } else if (pool.underlying_type === UnderlyingType.VIRTUAL_SINGLE) {
    const strategyContract = getStrategyContract(ctx.chainId, pool.strategy)
    const [,assetsAmounts] = await strategyContract.assetsAmounts()
    underlying_token_amount = scaleDown(assetsAmounts[0], pool.underlying_token_decimals)
  } else {
    // assume that its LP strategy
    const proceReaderContract = getPriceReaderContract(ctx.chainId, (deployments[ctx.chainId] as {
      factory: string,
      priceReader: string,
    }).priceReader)
    const priceReaderPrice = await proceReaderContract.getPrice(pool.underlying_token_address)
    const uPrice = scaleDown(priceReaderPrice[0], pool.underlying_token_decimals)
    underlying_token_amount = underlying_token_amount_usd.div(uPrice)
  }
  const total_fees_usd = pool.earned - pool.earnedSnapshot
  pool.earnedSnapshot = pool.earned
  await ctx.store.upsert(pool)

  ctx.eventLogger.emit('poolSnapshot', {
    timestamp: block.timestamp,
    block_date: Math.floor(block.timestamp / 86400) * 86400,
    chain_id: ctx.chainId,
    underlying_token_address: pool.underlying_token_address,
    underlying_token_index: pool.underlying_token_index,
    pool_address: pool.pool_address,
    underlying_token_amount,
    underlying_token_amount_usd,
    total_fees_usd,
  })
}

async function positionSnapshot(block: BlockParams, ctx: ContractContext<Vault, VaultBoundContractView>) {
  for await (const vault of ctx.store.listIterator(Pool, [])) {
    for await (const vaultUser of ctx.store.listIterator(VaultUser, [{
      field: "vault",
      op: "=",
      value: vault.pool_address
    }])) {
      ctx.eventLogger.emit('misc_depositors', {
        timestamp: block.timestamp,
        block_date: Math.floor(block.timestamp / 86400) * 86400,
        chain_id: ctx.chainId,
        pool_address: vault.pool_address,
        user_address: vaultUser.account,
        underlying_token_address: vault.underlying_token_address,
        underlying_token_index: vault.underlying_token_index,
        underlying_token_amount: vaultUser.underlying_token_amount,
        underlying_token_amount_usd: vaultUser.underlying_token_amount_usd,
        total_fees_usd: vaultUser.earned - vaultUser.earnedSnapshot,
      })
      vaultUser.earnedSnapshot = vaultUser.earned
      await ctx.store.upsert(vaultUser)
    }
  }
}

async function getVaultUnderlyingAmount(pool: Pool, chainId: EthChainId, vaultTvl: bigint) {
  if (pool.underlying_type === UnderlyingType.NATIVE) {
    const strategyContract = getStrategyContract(chainId, pool.strategy)
    return scaleDown(await strategyContract.total(), pool.underlying_token_decimals)
  } else if (pool.underlying_type === UnderlyingType.VIRTUAL_SINGLE) {
    const strategyContract = getStrategyContract(chainId, pool.strategy)
    const [,assetsAmounts] = await strategyContract.assetsAmounts()
    return scaleDown(assetsAmounts[0], pool.underlying_token_decimals)
  }

  // assume that its LP strategy
  const proceReaderContract = getPriceReaderContract(chainId, (deployments[chainId] as {
    factory: string,
    priceReader: string,
  }).priceReader)
  const priceReaderPrice = await proceReaderContract.getPrice(pool.underlying_token_address)
  const uPrice = scaleDown(priceReaderPrice[0], pool.underlying_token_decimals)
  const underlying_token_amount_usd = scaleDown(vaultTvl, 18)
  return underlying_token_amount_usd.div(uPrice)
}

for (const chain in deployments) {
  FactoryProcessor
    .bind({
      address: deployments[chain as EthChainId]?.factory as string,
      network: chain as EthChainId,
    })
    // new vault deployed
    .onEventVaultAndStrategy(async (event, ctx) => {

      // bind templates
      vaultTemplate.bind({
        address: event.args.vault,
        startBlock: ctx.blockNumber,
      }, ctx)
      strategyTemplate.bind({
        address: event.args.strategy,
        startBlock: ctx.blockNumber,
      }, ctx)

      // found underlying
      const strategyContract = getStrategyContract(ctx.chainId, event.args.strategy)
      let underlying = await strategyContract.underlying()
      let underlyingType = UnderlyingType.NATIVE
      // if strategy dont have underlying then underlying must be assets[0]
      if (underlying === "0x0000000000000000000000000000000000000000") {
        if (event.args.assets.length === 1) {
          underlyingType = UnderlyingType.VIRTUAL_SINGLE
          underlying = event.args.assets[0]
        } else {
          underlyingType = UnderlyingType.VIRTUAL_FIRST_ASSET
          underlying = event.args.assets[0]
        }
      }
      const underlyingTokenInfo = await token.getERC20TokenInfo(ctx, underlying)

      // insert Pool (its Vault here)
      const pool = new Pool({
        id: event.args.vault,

        // Schema fields
        chain_id: +ctx.chainId,
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        creation_block_number: ctx.blockNumber,
        receipt_token_address: event.args.vault,
        receipt_token_symbol: event.args.symbol,
        receipt_token_decimals: 18,
        underlying_token_address: underlying,
        underlying_token_index: Number(event.args.vaultManagerTokenId),
        underlying_token_symbol: underlyingTokenInfo.symbol,
        underlying_token_decimals: underlyingTokenInfo.decimal,
        pool_address: event.args.vault,
        pool_symbol: event.args.symbol,

        // helper fields
        underlying_type: underlyingType,
        strategy: event.args.strategy,
        earned: 0,
        earnedSnapshot: 0,

      })
      await ctx.store.upsert(pool)

      // insert Strategy
      const strategy = new Strategy({
        id: event.args.strategy,
        vault: event.args.vault,
      })
      await ctx.store.upsert(strategy)

    })

}
