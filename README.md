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

Thanks @0x76ADF1

```
WITH
  dates AS (
    SELECT
      addDays (start_date, number) AS day
    FROM
      (
        SELECT
          toDate (min(timestamp)) AS start_date
        FROM
          `misc_depositors`
      ) AS date_range ARRAY
      JOIN range (dateDiff('day', start_date, toDate (now()))) AS number
  )
SELECT
  toUnixTimestamp (coalesce(min(m.timestamp), toDateTime (d.day))) as timestamp,
  toString (d.day) as block_date,
  any (m.chain_id) as chain_id,
  m.pool_address,
  m.user_address,
  m.underlying_token_address,
  any (m.underlying_token_index) as underlying_token_index,
  any (m.underlying_token_amount) as underlying_token_amount,
  any (m.underlying_token_amount_usd) as underlying_token_amount_usd,
  any (m.total_fees_usd) as total_fees_usd
FROM
  dates d
  LEFT JOIN `misc_depositors` m ON toDate (m.timestamp) = d.day
WHERE
  d.day <= toDate (now())
GROUP BY
  d.day,
  m.pool_address,
  m.user_address,
  m.underlying_token_address
HAVING
  timestamp > timestamp('{{timestamp}}')
ORDER BY
  timestamp
```

### Pool Snapshot

Thanks @0x76ADF1

```
WITH
  dates AS (
    SELECT
      addDays (start_date, number) AS day
    FROM
      (
        SELECT
          toDate (min(timestamp)) AS start_date
        FROM
          `poolSnapshot`
      ) AS date_range ARRAY
      JOIN range (dateDiff('day', start_date, toDate (now()))) AS number
  )
SELECT
  toUnixTimestamp (coalesce(min(p.timestamp), toDateTime (d.day))) as timestamp,
  toString (d.day) as block_date,
  any (p.chain_id) as chain_id,
  p.underlying_token_address,
  any (p.underlying_token_index) as underlying_token_index,
  p.pool_address,
  any (p.underlying_token_amount) as underlying_token_amount,
  any (p.underlying_token_amount_usd) as underlying_token_amount_usd,
  any (p.total_fees_usd) as total_fees_usd
FROM
  dates d
  LEFT JOIN `poolSnapshot` p ON toDate (p.timestamp) = d.day
WHERE
  d.day <= toDate (now())
GROUP BY
  d.day,
  p.pool_address,
  p.underlying_token_address
HAVING
  timestamp > timestamp('{{timestamp}}')
ORDER BY
  timestamp
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
