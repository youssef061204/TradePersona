import { parse as parseCsv } from "csv-parse";
import fs from "fs";
import { Readable } from "stream";

function looksLikeJsonBuffer(buf) {
  for (let i = 0; i < Math.min(buf.length, 1024); i++) {
    const ch = String.fromCharCode(buf[i]);
    if (!/\s/.test(ch)) {
      return ch === "{" || ch === "[";
    }
  }
  return false;
}

export async function parseUpload(buffer, { normalizedPath = null } = {}) {
  if (!buffer || buffer.length === 0) throw new Error("Empty upload");

  if (looksLikeJsonBuffer(buffer)) {
    const text = buffer.toString("utf8");
    const { trades, mode } = parseJson(text);
    return { trades, mode, normalized: false, dateRange: null, normalizedPath: null };
  }

  return await parseCsvTrades(buffer, normalizedPath);
}

// -------- JSON path (your example format)
function parseJson(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON upload");
  }

  // Supports: { "transactions": [ ... ] } OR just [ ... ]
  const txs = Array.isArray(obj) ? obj : obj.transactions;
  if (!Array.isArray(txs) || !txs.length) {
    throw new Error("JSON must contain an array 'transactions'");
  }

  const trades = txs.map((t, i) => {
    const cash = Number(t.cash_cad);
    const side = cash < 0 ? "BUY" : cash > 0 ? "SELL" : null;

    const ts = t.order_date ?? t.settlement_date;
    const asset = String(t.symbol ?? "").toUpperCase();

    const qty = t.quantity ?? null;
    const price = t.price_cad ?? null;

    // trade size: prefer abs(cash), fallback qty*price
    const notional =
      Number.isFinite(cash) && cash !== 0
        ? Math.abs(cash)
        : qty != null && price != null
          ? Math.abs(Number(qty) * Number(price))
          : null;

    if (!ts || !asset) {
      throw new Error("Each transaction must include order_date/settlement_date and symbol");
    }

    return {
      tradeId: String(i + 1),
      ts,
      side,
      asset,
      qty,
      notional,
      pl: null, // not provided in this format
      fees: null,
      sourceFormat: "transactions_json",
    };
  });

  return { trades, mode: "basic" };
}

function csvCell(value) {
  if (value === null || value === undefined || value === "") return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function createCsvWriter(destPath) {
  if (!destPath) {
    return {
      write() {},
      end: () => Promise.resolve(),
    };
  }

  const stream = fs.createWriteStream(destPath);
  stream.write("timestamp,side,asset,quantity,entry_price,profit_loss\n");

  return {
    write(trade) {
      const entryPrice =
        trade.entryPrice != null && trade.entryPrice !== "" && Number.isFinite(Number(trade.entryPrice))
          ? Number(trade.entryPrice)
          : Number.isFinite(trade.qty) &&
              trade.qty !== 0 &&
              Number.isFinite(trade.notional)
            ? Math.abs(trade.notional) / Math.abs(trade.qty)
            : null;

      const tsValue = trade.ts instanceof Date ? trade.ts.toISOString() : trade.ts;
      const row = [
        tsValue,
        trade.side ?? "",
        trade.asset ?? "",
        trade.qty ?? "",
        entryPrice ?? "",
        trade.pl ?? "",
      ]
        .map(csvCell)
        .join(",") + "\n";

      stream.write(row);
    },
    end() {
      return new Promise((resolve, reject) => {
        stream.on("finish", resolve);
        stream.on("error", reject);
        stream.end();
      });
    },
  };
}

function numOrNull(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

// -------- CSV path (flexible headers; P/L optional) - streaming + single pass normalization
function parseCsvTrades(buffer, normalizedPath) {
  return new Promise((resolve, reject) => {
    const trades = [];
    const writer = createCsvWriter(normalizedPath);

    let pick = null;
    let kTs = null;
    let kSide = null;
    let kAsset = null;
    let kPL = null;
    let kQty = null;
    let kNotional = null;
    let kEntryPrice = null;
    let kExitPrice = null;
    let mode = "basic";

    let minTs = null;
    let maxTs = null;

    const parser = parseCsv({
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    parser.on("readable", () => {
      let record;
      while ((record = parser.read())) {
        if (!pick) {
          const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
          const keys = Object.keys(record);
          const map = Object.fromEntries(keys.map((k) => [norm(k), k]));
          pick = (...cands) => cands.map((c) => map[norm(c)]).find(Boolean) ?? null;

          kTs = pick("timestamp", "time", "date", "order_date", "orderdate", "settlement_date");
          kSide = pick("buy/sell", "side", "action", "type");
          kAsset = pick("asset", "symbol", "ticker");
          kPL = pick("p/l", "pl", "pnl", "profit", "profit_loss", "profitloss", "realizedpnl");
          kQty = pick("qty", "quantity");
          kNotional = pick("notional", "cash", "cash_cad", "amount");
          kEntryPrice = pick("entry_price", "price", "avg_price", "price_cad");
          kExitPrice = pick("exit_price", "sell_price", "avg_exit_price", "exitprice");

          if (!kTs || !kAsset) {
            parser.destroy(new Error("CSV missing Timestamp and Asset/Symbol columns"));
            return;
          }
          mode = kPL ? "full" : "basic";
        }

        const tsRaw = record[kTs];
        const ts = new Date(tsRaw);
        if (Number.isNaN(ts.valueOf())) continue;

        const rawQty = kQty ? record[kQty] : record.Qty ?? record.QTY ?? null;
        const rawNotional = kNotional ? record[kNotional] : record.Notional ?? record.NOTIONAL ?? null;
        const rawEntryPrice = kEntryPrice ? record[kEntryPrice] : null;
        const rawExitPrice = kExitPrice ? record[kExitPrice] : null;
        const qtyNum = numOrNull(rawQty);
        const entryPriceNum = numOrNull(rawEntryPrice) ?? numOrNull(rawExitPrice);
        const notionalNum =
          numOrNull(rawNotional) ??
          (entryPriceNum != null && qtyNum != null ? Math.abs(entryPriceNum * qtyNum) : null);

        const trade = {
          tradeId: String(record.TradeId ?? record.TRADE_ID ?? trades.length + 1),
          ts,
          side: kSide ? String(record[kSide]).toUpperCase() : null,
          asset: record[kAsset] ? String(record[kAsset]).toUpperCase() : null,
          qty: qtyNum,
          notional: notionalNum,
          entryPrice: entryPriceNum,
          pl: numOrNull(kPL ? record[kPL] : record["P/L"] ?? record["p/l"] ?? null),
          fees: record.Fees ?? record.FEES ?? null,
          sourceFormat: "csv",
        };

        trades.push(trade);
        writer.write(trade);

        if (!minTs || ts < minTs) minTs = ts;
        if (!maxTs || ts > maxTs) maxTs = ts;
      }
    });

    parser.on("error", async (err) => {
      try {
        await writer.end();
      } finally {
        reject(err);
      }
    });

    parser.on("end", async () => {
      try {
        await writer.end();
        if (!trades.length) {
          return reject(new Error("CSV had no rows"));
        }
        resolve({
          trades,
          mode,
          normalized: true,
          dateRange: { minTs, maxTs },
          normalizedPath: normalizedPath ?? null,
        });
      } catch (err) {
        reject(err);
      }
    });

    Readable.from(buffer).pipe(parser);
  });
}
