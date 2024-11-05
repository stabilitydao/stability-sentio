# Stability Sentio Processor

The main purpose of this indexer is to represent Stability platform data in the form of standard schema for [Yield Aggregator](https://github.com/delta-hq/schemas/blob/main/schemas/yield-aggregator/SCHEMA.md).
We need the data in this form for integration with [OpenBlock Labs (OBL)](https://www.openblocklabs.com/) for participation in points incentive programs.

## Queries

### Pools

```
select
  chain_id,
  timestamp,
  creation_block_number,
  underlying_token_address,
  underlying_token_index,
  underlying_token_symbol,
  underlying_token_decimals,
  receipt_token_address,
  receipt_token_symbol,
  receipt_token_decimals,
  pool_address,
  pool_symbol
from
  Pool
```

### Position Snapshot

```
select
  toUnixTimestamp (timestamp) as timestamp,
  FROM_UNIXTIME(CAST(block_date as Int64)) as block_date,
  chain_id,
  pool_address,
  user_address,
  underlying_token_address,
  underlying_token_index,
  underlying_token_amount,
  underlying_token_amount_usd,
  total_fees_usd
from
  `misc_depositors`
where
  timestamp > timestamp('{{timestamp}}')
```

### Pool Snapshot

```
select
  toUnixTimestamp (timestamp) as timestamp,
  FROM_UNIXTIME(CAST(block_date as Int64)) as block_date,
  chain_id,
  underlying_token_address,
  underlying_token_index,
  pool_address,
  underlying_token_amount,
  underlying_token_amount_usd,
  total_fees_usd
from
  `poolSnapshot`
    where
  timestamp > timestamp('{{timestamp}}')
```

### Events

```
select
  toUnixTimestamp (timestamp) as timestamp,
  chain_id,
  block_number,
  log_index,
  transaction_hash,
  user_address,
  taker_address,
  pool_address,
  underlying_token_address,
  amount,
  amount_usd,
  event_type
from
  `misc_events`
where
  timestamp > timestamp('{{timestamp}}')
```

## Useful links 

* [compound-v2 processor by OBL](https://github.com/delta-hq/sentio-processors/blob/main/processors/compound-v2-ethereum/src/processor.ts)
