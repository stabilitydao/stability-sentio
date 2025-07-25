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
  /*[EthChainId.POLYGON]: {
    factory: "0xa14EaAE76890595B3C7ea308dAEBB93863480EAD",
    priceReader: "0xcCef9C4459d73F9A997ff50AC34364555A3274Aa",
  },*/
  [EthChainId.SONIC_MAINNET]: {
    factory: "0xc184a3ecca684f2621c903a7943d85fa42f56671",
    priceReader: "0x422025182dd83a610bfa8b20550dcccdf94dc549",
  },
}

// IVault contracts
const vaultTemplate = new VaultProcessorTemplate()
  // vault symbol changed
  .onEventVaultSymbol(async (event, ctx) => {
    const vault0 = await ctx.store.get(Pool, event.address.toLowerCase() + '-0') as Pool
    vault0.pool_symbol = event.args.newSymbol
    vault0.receipt_token_symbol = event.args.newSymbol
    await ctx.store.upsert(vault0)
    if (vault0.underlying_type === UnderlyingType.VIRTUAL_EACH_ASSET) {
      const vault1 = await ctx.store.get(Pool, event.address.toLowerCase() + '-1') as Pool
      vault1.pool_symbol = event.args.newSymbol
      vault1.receipt_token_symbol = event.args.newSymbol
      await ctx.store.upsert(vault1)
    }
  })
  // user deposit
  .onEventDepositAssets(async (event, ctx) => {
    const tvl = await ctx.contract.tvl()
    const totalSupply = scaleDown(await ctx.contract.totalSupply(), 18)
    const userBalance = scaleDown(await ctx.contract.balanceOf(event.args.account), 18)
    const mintAmount = scaleDown(event.args.mintAmount, 18)

    const vault0 = await ctx.store.get(Pool, event.address.toLowerCase() + '-0') as Pool
    const [vault0UnderlyingAmount, vault0UnderlyingUsd] = await getVaultUnderlyingAmount(vault0, ctx.chainId, tvl[0], event.blockNumber)
    const vault0UserUnderlyingTokenAmount = userBalance.times(vault0UnderlyingAmount).div(totalSupply)
    const vault0UserUnderlyingTokenAmountUsd = userBalance.times(vault0UnderlyingUsd).div(totalSupply)

    let vault0User = await ctx.store.get(VaultUser, event.args.account.toLowerCase() + '-' + event.address.toLowerCase() + '-0')
    if (!vault0User) {
      vault0User = new VaultUser({
        id: event.args.account.toLowerCase() + '-' + event.address.toLowerCase() + '-0',
        vault: event.address,
        account: event.args.account,
        earned: BigDecimal(0),
        earnedSnapshot: BigDecimal(0),
        underlying_token_amount: BigDecimal(0),
        underlying_token_amount_usd: BigDecimal(0),
        underlying_token_index: 0,
      })
    }
    vault0User.underlying_token_amount = vault0UserUnderlyingTokenAmount
    vault0User.underlying_token_amount_usd = vault0UserUnderlyingTokenAmountUsd
    await ctx.store.upsert(vault0User)

    if (vault0.underlying_type === UnderlyingType.VIRTUAL_EACH_ASSET) {
      const vault1 = await ctx.store.get(Pool, event.address.toLowerCase() + '-1') as Pool
      const [vault1UnderlyingAmount, vault1UnderlyingUsd] = await getVaultUnderlyingAmount(vault1, ctx.chainId, tvl[0], event.blockNumber)
      const vault1UserUnderlyingTokenAmount = userBalance.times(vault1UnderlyingAmount).div(totalSupply)
      const vault1UserUnderlyingTokenAmountUsd = userBalance.times(vault1UnderlyingUsd).div(totalSupply)

      let vault1User = await ctx.store.get(VaultUser, event.args.account.toLowerCase() + '-' + event.address.toLowerCase() + '-1')
      if (!vault1User) {
        vault1User = new VaultUser({
          id: event.args.account.toLowerCase() + '-' + event.address.toLowerCase() + '-1',
          vault: event.address,
          account: event.args.account,
          earned: BigDecimal(0),
          earnedSnapshot: BigDecimal(0),
          underlying_token_amount: BigDecimal(0),
          underlying_token_amount_usd: BigDecimal(0),
          underlying_token_index: 1,
        })
      }
      vault1User.underlying_token_amount = vault1UserUnderlyingTokenAmount
      vault1User.underlying_token_amount_usd = vault1UserUnderlyingTokenAmountUsd
      await ctx.store.upsert(vault1User)

      const vault0Prop = vault0UnderlyingUsd.div(vault0UnderlyingUsd.plus(vault1UnderlyingUsd))

      ctx.eventLogger.emit('misc_events', {
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        chain_id: ctx.chainId,
        block_number: event.blockNumber,
        log_index: event.index,
        transaction_hash: event.transactionHash,
        user_address: event.args.account,
        taker_address: event.args.account,
        pool_address: vault0.pool_address,
        underlying_token_address: vault0.underlying_token_address,
        amount: mintAmount.times(vault0Prop),
        amount_usd: mintAmount.times(vault0UserUnderlyingTokenAmountUsd).div(userBalance),
        event_type: 'deposit',
      })
      ctx.eventLogger.emit('misc_events', {
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        chain_id: ctx.chainId,
        block_number: event.blockNumber,
        log_index: event.index,
        transaction_hash: event.transactionHash,
        user_address: event.args.account,
        taker_address: event.args.account,
        pool_address: vault0.pool_address,
        underlying_token_address: vault1.underlying_token_address,
        amount: mintAmount.times(BigDecimal('1', 18).minus(vault0Prop)),
        amount_usd: mintAmount.times(vault1UserUnderlyingTokenAmountUsd).div(userBalance),
        event_type: 'deposit',
      })
    } else {
      ctx.eventLogger.emit('misc_events', {
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        chain_id: ctx.chainId,
        block_number: event.blockNumber,
        log_index: event.index,
        transaction_hash: event.transactionHash,
        user_address: event.args.account,
        taker_address: event.args.account,
        pool_address: vault0.pool_address,
        underlying_token_address: vault0.underlying_token_address,
        amount: mintAmount,
        amount_usd: mintAmount.times(scaleDown(tvl[0], 18)).div(totalSupply),
        event_type: 'deposit',
      })
    }

  })
  // user withdraw
  .onEventWithdrawAssets(async (event, ctx) => {
    const tvl = await ctx.contract.tvl()
    const totalSupply = scaleDown(await ctx.contract.totalSupply(), 18)
    const burnAmount = scaleDown(event.args.sharesAmount, 18)
    const userBalance = scaleDown(await ctx.contract.balanceOf(event.args.owner), 18)

    const vault0 = await ctx.store.get(Pool, event.address.toLowerCase() + '-0') as Pool
    const [vault0UnderlyingAmount, vault0UnderlyingUsd] = await getVaultUnderlyingAmount(vault0, ctx.chainId, tvl[0], event.blockNumber)
    const vault0UserUnderlyingTokenAmount = userBalance.times(vault0UnderlyingAmount).div(totalSupply)
    const vault0UserUnderlyingTokenAmountUsd = userBalance.times(vault0UnderlyingUsd).div(totalSupply)

    const vault0User = await ctx.store.get(VaultUser, event.args.owner.toLowerCase() + '-' + event.address.toLowerCase() + '-0') as VaultUser
    if (vault0User) {
      vault0User.underlying_token_amount = vault0UserUnderlyingTokenAmount
      vault0User.underlying_token_amount_usd = vault0UserUnderlyingTokenAmountUsd
      await ctx.store.upsert(vault0User)
    }

    if (vault0.underlying_type === UnderlyingType.VIRTUAL_EACH_ASSET) {
      const vault1 = await ctx.store.get(Pool, event.address.toLowerCase() + '-1') as Pool
      const [vault1UnderlyingAmount, vault1UnderlyingUsd] = await getVaultUnderlyingAmount(vault1, ctx.chainId, tvl[0], event.blockNumber)
      const vault1UserUnderlyingTokenAmount = userBalance.times(vault1UnderlyingAmount).div(totalSupply)
      const vault1UserUnderlyingTokenAmountUsd = userBalance.times(vault1UnderlyingUsd).div(totalSupply)

      const vault1User = await ctx.store.get(VaultUser, event.args.owner.toLowerCase() + '-' + event.address.toLowerCase() + '-1') as VaultUser
      if (vault1User) {
        vault1User.underlying_token_amount = vault1UserUnderlyingTokenAmount
        vault1User.underlying_token_amount_usd = vault1UserUnderlyingTokenAmountUsd
        await ctx.store.upsert(vault1User)
      }

      const vault0Prop = vault0UnderlyingUsd.div(vault0UnderlyingUsd.plus(vault1UnderlyingUsd))

      ctx.eventLogger.emit('misc_events', {
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        chain_id: ctx.chainId,
        block_number: event.blockNumber,
        log_index: event.index,
        transaction_hash: event.transactionHash,
        user_address: event.args.owner,
        taker_address: event.args.owner,
        pool_address: vault0.pool_address,
        underlying_token_address: vault0.underlying_token_address,
        amount: burnAmount.times(vault0Prop),
        amount_usd: burnAmount.times(scaleDown(tvl[0], 18)).div(totalSupply.plus(burnAmount)).times(vault0Prop),
        event_type: 'withdrawal',
      })
      ctx.eventLogger.emit('misc_events', {
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        chain_id: ctx.chainId,
        block_number: event.blockNumber,
        log_index: event.index,
        transaction_hash: event.transactionHash,
        user_address: event.args.owner,
        taker_address: event.args.owner,
        pool_address: vault1.pool_address,
        underlying_token_address: vault1.underlying_token_address,
        amount: burnAmount.times(BigDecimal('1', 18).minus(vault0Prop)),
        amount_usd: burnAmount.times(scaleDown(tvl[0], 18)).div(totalSupply.plus(burnAmount)).times(BigDecimal('1', 18).minus(vault0Prop)),
        event_type: 'withdrawal',
      })
    } else {
      ctx.eventLogger.emit('misc_events', {
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        chain_id: ctx.chainId,
        block_number: event.blockNumber,
        log_index: event.index,
        transaction_hash: event.transactionHash,
        user_address: event.args.owner,
        taker_address: event.args.owner,
        pool_address: vault0.pool_address,
        underlying_token_address: vault0.underlying_token_address,
        amount: burnAmount,
        amount_usd: burnAmount.times(scaleDown(tvl[0], 18)).div(totalSupply.plus(burnAmount)),
        event_type: 'withdrawal',
      })
    }

  })
  // user transfer
  .onEventTransfer(async (event, ctx) => {
    if (
      event.args.from !== "0x0000000000000000000000000000000000000000"
      && event.args.to !== "0x0000000000000000000000000000000000000000"
    ) {
      const transferAmount = scaleDown(event.args.value, 18)
      const tvl = await ctx.contract.tvl()
      const totalSupply = scaleDown(await ctx.contract.totalSupply(), 18)
      const userBalanceFrom = scaleDown(await ctx.contract.balanceOf(event.args.from), 18)
      const userBalanceTo = scaleDown(await ctx.contract.balanceOf(event.args.to), 18)

      const vault0 = await ctx.store.get(Pool, event.address.toLowerCase() + '-0') as Pool
      const [vault0UnderlyingAmount, vault0UnderlyingUsd] = await getVaultUnderlyingAmount(vault0, ctx.chainId, tvl[0], event.blockNumber)

      const vault0UserFrom = await ctx.store.get(VaultUser, event.args.from.toLowerCase() + '-' + event.address.toLowerCase() + '-0') as VaultUser
      // can be empty on mint fees
      if (vault0UserFrom) {
        vault0UserFrom.underlying_token_amount = userBalanceFrom.times(vault0UnderlyingAmount).div(totalSupply)
        vault0UserFrom.underlying_token_amount_usd = userBalanceFrom.times(vault0UnderlyingUsd).div(totalSupply)
        await ctx.store.upsert(vault0UserFrom)
      }

      let vault0UserTo = await ctx.store.get(VaultUser, event.args.to.toLowerCase() + '-' + event.address.toLowerCase() + '-0')
      if (!vault0UserTo) {
        vault0UserTo = new VaultUser({
          id: event.args.to.toLowerCase() + '-' + event.address.toLowerCase() + '-0',
          vault: event.address,
          account: event.args.to,
          earned: BigDecimal(0),
          earnedSnapshot: BigDecimal(0),
          underlying_token_amount: BigDecimal(0),
          underlying_token_amount_usd: BigDecimal(0),
          underlying_token_index: 0,
        })
      }
      vault0UserTo.underlying_token_amount = userBalanceTo.times(vault0UnderlyingAmount).div(totalSupply)
      vault0UserTo.underlying_token_amount_usd = userBalanceTo.times(vault0UnderlyingUsd).div(totalSupply)
      await ctx.store.upsert(vault0UserTo)

      if (vault0.underlying_type === UnderlyingType.VIRTUAL_EACH_ASSET) {
        const vault1 = await ctx.store.get(Pool, event.address.toLowerCase() + '-1') as Pool
        const [vault1UnderlyingAmount, vault1UnderlyingUsd] = await getVaultUnderlyingAmount(vault1, ctx.chainId, tvl[0], event.blockNumber)

        const vault1UserFrom = await ctx.store.get(VaultUser, event.args.from.toLowerCase() + '-' + event.address.toLowerCase() + '-1') as VaultUser
        if (vault1UserFrom) {
          vault1UserFrom.underlying_token_amount = userBalanceFrom.times(vault1UnderlyingAmount).div(totalSupply)
          vault1UserFrom.underlying_token_amount_usd = userBalanceFrom.times(vault1UnderlyingUsd).div(totalSupply)
          await ctx.store.upsert(vault1UserFrom)
        }

        let vault1UserTo = await ctx.store.get(VaultUser, event.args.to.toLowerCase() + '-' + event.address.toLowerCase() + '-1')
        if (!vault1UserTo) {
          vault1UserTo = new VaultUser({
            id: event.args.to.toLowerCase() + '-' + event.address.toLowerCase() + '-1',
            vault: event.address,
            account: event.args.to,
            earned: BigDecimal(0),
            earnedSnapshot: BigDecimal(0),
            underlying_token_amount: BigDecimal(0),
            underlying_token_amount_usd: BigDecimal(0),
            underlying_token_index: 1,
          })
        }
        vault1UserTo.underlying_token_amount = userBalanceTo.times(vault1UnderlyingAmount).div(totalSupply)
        vault1UserTo.underlying_token_amount_usd = userBalanceTo.times(vault1UnderlyingUsd).div(totalSupply)
        await ctx.store.upsert(vault1UserTo)

        const vault0Prop = vault0UnderlyingUsd.div(vault0UnderlyingUsd.plus(vault1UnderlyingUsd))
        ctx.eventLogger.emit('misc_events', {
          timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
          chain_id: ctx.chainId,
          block_number: event.blockNumber,
          log_index: event.index,
          transaction_hash: event.transactionHash,
          user_address: event.args.from,
          taker_address: event.args.to,
          pool_address: vault0.pool_address,
          underlying_token_address: vault0.underlying_token_address,
          amount: transferAmount.times(vault0Prop),
          amount_usd: transferAmount.times(scaleDown(tvl[0], 18)).div(totalSupply).times(vault0Prop),
          event_type: 'transfer',
        })
        ctx.eventLogger.emit('misc_events', {
          timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
          chain_id: ctx.chainId,
          block_number: event.blockNumber,
          log_index: event.index,
          transaction_hash: event.transactionHash,
          user_address: event.args.from,
          taker_address: event.args.to,
          pool_address: vault1.pool_address,
          underlying_token_address: vault1.underlying_token_address,
          amount: transferAmount.times(BigDecimal('1', 18).minus(vault0Prop)),
          amount_usd: transferAmount.times(scaleDown(tvl[0], 18)).div(totalSupply).times(BigDecimal('1', 18).minus(vault0Prop)),
          event_type: 'transfer',
        })
      } else {
        ctx.eventLogger.emit('misc_events', {
          timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
          chain_id: ctx.chainId,
          block_number: event.blockNumber,
          log_index: event.index,
          transaction_hash: event.transactionHash,
          user_address: event.args.from,
          taker_address: event.args.to,
          pool_address: vault0.pool_address,
          underlying_token_address: vault0.underlying_token_address,
          amount: transferAmount,
          amount_usd: transferAmount.times(scaleDown(tvl[0], 18)).div(totalSupply),
          event_type: 'transfer',
        })
      }

    }

  })
  // regular snapshots
  .onTimeInterval(snapshots, 60 * 24, 60 * 24)

// IStrategy contracts
const strategyTemplate = new StrategyProcessorTemplate()
  .onEventHardWork(async (event, ctx) => {

    const blockNumber = event.blockNumber;
    const strategy = await ctx.store.get(Strategy, event.address) as Strategy
    const tvl = await getVaultContract(ctx.chainId, strategy.vault).tvl({blockTag: event.blockNumber,})

    const vault0 = await ctx.store.get(Pool, strategy.vault.toLowerCase() + '-0') as Pool
    const [vault0UnderlyingAmount, vault0UnderlyingUsd] = await getVaultUnderlyingAmount(vault0, ctx.chainId, tvl[0], event.blockNumber)
    let vault0Earned: BigDecimal = new BigDecimal(0);
    if (vault0.underlying_type === UnderlyingType.VIRTUAL_EACH_ASSET) {
      const vault1 = await ctx.store.get(Pool, strategy.vault.toLowerCase() + '-1') as Pool
      const [vault1UnderlyingAmount, vault1UnderlyingUsd] = await getVaultUnderlyingAmount(vault1, ctx.chainId, tvl[0], event.blockNumber)
      const vault0Prop = vault0UnderlyingUsd.div(vault0UnderlyingUsd.plus(vault1UnderlyingUsd))
      let vault1Earned: BigDecimal = new BigDecimal(0);
      if (event.args.earned > 0n) {
        vault0Earned = scaleDown(event.args.earned, 18).times(vault0Prop)
        vault1Earned = scaleDown(event.args.earned, 18).times(BigDecimal('1', 18).minus(vault0Prop));
      } else {
        const lastHardWork = await ctx.contract.lastHardWork({blockTag: blockNumber - 10,});
        const [assetAddresses, assetsAmounts] = await ctx.contract.assetsAmounts({blockTag: blockNumber,})

        const duration = Math.floor(ctx.timestamp.getTime() / 1000) - Number(lastHardWork);
        const secondsInYear = 31536000;
        if (duration > 0 && assetsAmounts.length > 0) {
          const asset = assetAddresses.length > 0 ? assetAddresses[0] : vault0.underlying_token_address;
          const assetDecimals = assetAddresses.length > 0 ? (await token.getERC20TokenInfo(ctx, asset)).decimal : vault0.underlying_token_decimals;
          const price = await getPriceByAsset(asset, ctx.chainId, blockNumber);
          const virtualRevenue = scaleDown(assetsAmounts[0], assetDecimals)
            .times(new BigDecimal(duration / secondsInYear / 30));
          vault0Earned = virtualRevenue.times(price).times(vault0Prop);
          vault1Earned = virtualRevenue.times(price).times(BigDecimal('1', 18).minus(vault0Prop));
          ctx.eventLogger.emit('Virtual_revenue', {
            distinctId: event.transactionHash,
            message: `Calculate virtual revenue`,
            price: price,
            virtualRevenue: virtualRevenue,
            vault0Earned: vault0Earned
          });
        }
      }

      vault1.earned = vault1.earned.plus(vault1Earned)
      await ctx.store.upsert(vault1)

      // add earned to all vault1 users
      for await (const vaultUser of ctx.store.listIterator(VaultUser, [{
        field: "vault",
        op: "=",
        value: vault0.pool_address
      }, {
        field: "underlying_token_index",
        op: "=",
        value: 1
      }])) {
        vaultUser.earned = vaultUser.earned.plus(vaultUser.underlying_token_amount.times(vault1Earned).div(vault1UnderlyingAmount))
        await ctx.store.upsert(vaultUser)
      }
    } else {
      if (event.args.earned > 0n) {
        vault0Earned = scaleDown(event.args.earned, 18)
      } else {
        const lastHardWork = await ctx.contract.lastHardWork({blockTag: blockNumber - 10,});
        const [assetAddresses, assetsAmounts] = await ctx.contract.assetsAmounts({blockTag: blockNumber,})

        const duration = Math.floor(ctx.timestamp.getTime() / 1000) - Number(lastHardWork);
        const secondsInYear = 31536000;
        if (duration > 0 && assetsAmounts.length > 0) {
          const asset = assetAddresses.length > 0 ? assetAddresses[0] : vault0.underlying_token_address;
          const assetDecimals = assetAddresses.length > 0 ? (await token.getERC20TokenInfo(ctx, asset)).decimal : vault0.underlying_token_decimals;
          const price = await getPriceByAsset(asset, ctx.chainId, blockNumber);
          const virtualRevenue = scaleDown(assetsAmounts[0], assetDecimals).times(new BigDecimal(duration / secondsInYear / 30));
          vault0Earned = virtualRevenue.times(price);
          ctx.eventLogger.emit('virtual_revenue', {
            distinctId: event.transactionHash,
            message: `Calculate virtual revenue for single`,
            price: price,
            virtualRevenue: virtualRevenue,
            vault0Earned: vault0Earned,
          });
        }
      }
    }

    vault0.earned = vault0.earned.plus(vault0Earned)
    await ctx.store.upsert(vault0)

    // add earned to all vault0 users
    for await (const vaultUser of ctx.store.listIterator(VaultUser, [{
      field: "vault",
      op: "=",
      value: vault0.pool_address
    }, {
      field: "underlying_token_index",
      op: "=",
      value: 0
    }])) {
      vaultUser.earned = vaultUser.earned.plus(vaultUser.underlying_token_amount.times(vault0Earned).div(vault0UnderlyingAmount))
      await ctx.store.upsert(vaultUser)
    }
  })

async function snapshots(block: BlockParams, ctx: ContractContext<Vault, VaultBoundContractView>) {
  await poolSnapshot(block, ctx)
  await positionSnapshot(block, ctx)
}

async function poolSnapshot(block: BlockParams, ctx: ContractContext<Vault, VaultBoundContractView>) {
  const tvl = await ctx.contract.tvl()

  const pool0 = await ctx.store.get(Pool, ctx.contract.address.toLowerCase() + '-0') as Pool
  if (pool0) {
    const pool0_total_fees_usd = pool0.earned.minus(pool0.earnedSnapshot)
    pool0.earnedSnapshot = pool0.earned
    await ctx.store.upsert(pool0)

    const [vault0UnderlyingAmount, vault0UnderlyingUsd] = await getVaultUnderlyingAmount(pool0, ctx.chainId, tvl[0], block.number)

    ctx.eventLogger.emit('poolSnapshot', {
      timestamp: block.timestamp,
      block_date: Math.floor(block.timestamp / 86400) * 86400,
      chain_id: ctx.chainId,
      underlying_token_address: pool0.underlying_token_address,
      underlying_token_index: pool0.underlying_token_index,
      pool_address: pool0.pool_address,
      underlying_token_amount_usd: vault0UnderlyingUsd,
      total_fees_usd: pool0_total_fees_usd,
      // internal
      underlying_token_amount_str: vault0UnderlyingAmount.toFixed(pool0.underlying_token_decimals),
      underlying_token_decimals: pool0.underlying_token_decimals,
    })

    if (pool0.underlying_type === UnderlyingType.VIRTUAL_EACH_ASSET) {
      const pool1 = await ctx.store.get(Pool, ctx.contract.address.toLowerCase() + '-1') as Pool
      const pool1_total_fees_usd = pool1.earned.minus(pool1.earnedSnapshot)
      pool1.earnedSnapshot = pool1.earned
      await ctx.store.upsert(pool1)

      const [vault1UnderlyingAmount, vault1UnderlyingUsd] = await getVaultUnderlyingAmount(pool1, ctx.chainId, tvl[0], block.number)

      ctx.eventLogger.emit('poolSnapshot', {
        timestamp: block.timestamp,
        block_date: Math.floor(block.timestamp / 86400) * 86400,
        chain_id: ctx.chainId,
        underlying_token_address: pool1.underlying_token_address,
        underlying_token_index: pool1.underlying_token_index,
        pool_address: pool1.pool_address,
        // underlying_token_amount: vault1UnderlyingAmount,
        underlying_token_amount_usd: vault1UnderlyingUsd,
        total_fees_usd: pool1_total_fees_usd,
        // internal
        underlying_token_amount_str: vault0UnderlyingAmount.toFixed(pool0.underlying_token_decimals),
        underlying_token_decimals: pool0.underlying_token_decimals,
      })
    }
  } else {
    console.log(`Cant get pool with id ${ctx.contract.address + '-0'}`)
  }

}

async function positionSnapshot(block: BlockParams, ctx: ContractContext<Vault, VaultBoundContractView>) {
  const vault0 = await ctx.store.get(Pool, ctx.contract.address.toLowerCase() + '-0') as Pool
  if (vault0) {
    const vault0Users: {[id:string]: VaultUser} = {}
    for await (const vaultUser of ctx.store.listIterator(VaultUser, [{
      field: "vault",
      op: "=",
      value: vault0.pool_address
    }, {
      field: "underlying_token_index",
      op: "=",
      value: vault0.underlying_token_index,
    }])) {
      vault0Users[vaultUser.id.toString()] = vaultUser
    }
    for (const vaultUserId in vault0Users) {
      const vaultUser = vault0Users[vaultUserId]
      ctx.eventLogger.emit('misc_depositors', {
        timestamp: block.timestamp,
        block_date: Math.floor(block.timestamp / 86400) * 86400,
        chain_id: ctx.chainId,
        pool_address: vault0.pool_address,
        user_address: vaultUser.account,
        underlying_token_address: vault0.underlying_token_address,
        underlying_token_index: vault0.underlying_token_index,
        // underlying_token_amount: vaultUser.underlying_token_amount,
        underlying_token_amount_usd: vaultUser.underlying_token_amount_usd,
        total_fees_usd: vaultUser.earned.minus(vaultUser.earnedSnapshot),
        // internal
        underlying_token_amount_str: vaultUser.underlying_token_amount.toFixed(vault0.underlying_token_decimals),
        underlying_token_decimals: vault0.underlying_token_decimals,
      })
      vaultUser.earnedSnapshot = vaultUser.earned
      await ctx.store.upsert(vaultUser)
    }

    if (vault0.underlying_type === UnderlyingType.VIRTUAL_EACH_ASSET) {
      const vault1 = await ctx.store.get(Pool, ctx.contract.address.toLowerCase() + '-1') as Pool
      const vault1Users: {[id:string]: VaultUser} = {}
      for await (const vaultUser of ctx.store.listIterator(VaultUser, [{
        field: "vault",
        op: "=",
        value: vault1.pool_address
      }, {
        field: "underlying_token_index",
        op: "=",
        value: vault1.underlying_token_index,
      }])) {
        vault1Users[vaultUser.id.toString()] = vaultUser
      }
      for (const vaultUserId in vault1Users) {
        const vaultUser = vault1Users[vaultUserId]
        ctx.eventLogger.emit('misc_depositors', {
          timestamp: block.timestamp,
          block_date: Math.floor(block.timestamp / 86400) * 86400,
          chain_id: ctx.chainId,
          pool_address: vault1.pool_address,
          user_address: vaultUser.account,
          underlying_token_address: vault1.underlying_token_address,
          underlying_token_index: vault1.underlying_token_index,
          // underlying_token_amount: vaultUser.underlying_token_amount,
          underlying_token_amount_usd: vaultUser.underlying_token_amount_usd,
          total_fees_usd: vaultUser.earned.minus(vaultUser.earnedSnapshot),
          // internal
          underlying_token_amount_str: vaultUser.underlying_token_amount.toFixed(vault1.underlying_token_decimals),
          underlying_token_decimals: vault1.underlying_token_decimals,
        })
        vaultUser.earnedSnapshot = vaultUser.earned
        await ctx.store.upsert(vaultUser)
      }
    }
  } else {
    console.log(`Cant get pool with id ${ctx.contract.address + '-0'}`)
  }
}

async function getVaultUnderlyingAmount(pool: Pool, chainId: EthChainId, vaultTvl: bigint, blockNumber: number): Promise<BigDecimal[]> {
  const strategyContract = getStrategyContract(chainId, pool.strategy)
  if (pool.underlying_type === UnderlyingType.NATIVE) {
    return [
      scaleDown(await strategyContract.total({blockTag: blockNumber,}), pool.underlying_token_decimals),
      scaleDown(vaultTvl, 18),
    ]
  } else if (pool.underlying_type === UnderlyingType.VIRTUAL_SINGLE) {
    const [,assetsAmounts] = await strategyContract.assetsAmounts({blockTag: blockNumber,})
    return [
      scaleDown(assetsAmounts[0], pool.underlying_token_decimals),
      scaleDown(vaultTvl, 18),
    ]
  }

  // CLMM vault
  const [,assetsAmounts] = await strategyContract.assetsAmounts({blockTag: blockNumber,})
  const underlyingAmount = scaleDown(assetsAmounts[pool.underlying_token_index], pool.underlying_token_decimals)
  const priceReaderContract = getPriceReaderContract(chainId, (deployments[chainId] as {
    factory: string,
    priceReader: string,
  }).priceReader)
  const priceReaderPrice = await priceReaderContract.getPrice(pool.underlying_token_address, {blockTag: blockNumber,})
  const uPrice = scaleDown(priceReaderPrice[0], 18)
  return [underlyingAmount, underlyingAmount.times(uPrice)]
}

async function getPriceByAsset(asset: string, chainId: EthChainId, blockNumber: number): Promise<BigDecimal> {
  const priceReaderContract = getPriceReaderContract(chainId, (deployments[chainId] as {
    factory: string,
    priceReader: string,
  }).priceReader)

  const priceReaderPrice = await priceReaderContract.getPrice(asset, {blockTag: blockNumber,})
  return scaleDown(priceReaderPrice[0], 18)
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

      // assignment underlying
      const strategyContract = getStrategyContract(ctx.chainId, event.args.strategy)
      let underlying0 = await strategyContract.underlying({blockTag: event.blockNumber,})
      let underlyingType = UnderlyingType.NATIVE
      if (underlying0 === "0x0000000000000000000000000000000000000000") {
        if (event.args.assets.length === 1) {
          underlyingType = UnderlyingType.VIRTUAL_SINGLE
          underlying0 = event.args.assets[0]
        } else {
          underlyingType = UnderlyingType.VIRTUAL_EACH_ASSET
          underlying0 = event.args.assets[0]
        }
      }

      // insert Strategy
      const strategy = new Strategy({
        id: event.args.strategy,
        vault: event.args.vault,
      })
      await ctx.store.upsert(strategy)

      const underlyingToken0Info = await token.getERC20TokenInfo(ctx, underlying0)

      // insert Pool (its Vault here)
      const pool = new Pool({
        id: `${event.args.vault.toLowerCase()}-0`,

        // Schema fields
        chain_id: +ctx.chainId,
        timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
        creation_block_number: ctx.blockNumber,
        receipt_token_address: event.args.vault,
        receipt_token_symbol: event.args.symbol,
        receipt_token_decimals: 18,
        underlying_token_address: underlying0,
        underlying_token_index: 0,
        underlying_token_symbol: underlyingToken0Info.symbol,
        underlying_token_decimals: underlyingToken0Info.decimal,
        pool_address: event.args.vault,
        pool_symbol: event.args.symbol,

        // helper fields
        underlying_type: underlyingType,
        strategy: event.args.strategy,
        earned: BigDecimal(0),
        earnedSnapshot: BigDecimal(0),
      })
      await ctx.store.upsert(pool)

      if (underlyingType === UnderlyingType.VIRTUAL_EACH_ASSET) {
        // insert second pool for token1
        const underlyingToken1Info = await token.getERC20TokenInfo(ctx, event.args.assets[1])

        const pool2 = new Pool({
          id: `${event.args.vault.toLowerCase()}-1`,

          // Schema fields
          chain_id: +ctx.chainId,
          timestamp: Math.floor(ctx.timestamp.getTime() / 1000),
          creation_block_number: ctx.blockNumber,
          receipt_token_address: event.args.vault,
          receipt_token_symbol: event.args.symbol,
          receipt_token_decimals: 18,
          underlying_token_address: event.args.assets[1],
          underlying_token_index: 1,
          underlying_token_symbol: underlyingToken1Info.symbol,
          underlying_token_decimals: underlyingToken1Info.decimal,
          pool_address: event.args.vault,
          pool_symbol: event.args.symbol,

          // helper fields
          underlying_type: underlyingType,
          strategy: event.args.strategy,
          earned: BigDecimal(0),
          earnedSnapshot: BigDecimal(0),
        })
        await ctx.store.upsert(pool2)
      }

    })

}
