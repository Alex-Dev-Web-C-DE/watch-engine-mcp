import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 8080;
const WATCH_API = "https://watch-engine.boring-saas-infra.workers.dev";

const app = express();
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "watch-engine-mcp",
    version: "1.0.0",
  });
});

// MCP server factory
function createMcpServer() {
  const server = new McpServer({
    name: "watch-engine",
    version: "1.0.0",
  });

  server.tool(
    "get_currency_rate",
    "Get current exchange rate between two currencies",
    {
      from: z.string().describe("Base currency code (e.g. USD)"),
      to: z.string().describe("Target currency code (e.g. EUR)"),
    },
    async ({ from, to }) => {
      const fromUp = from.toUpperCase();
      const toUp = to.toUpperCase();

      // Try frankfurter (ECB rates) first
      const url = `${WATCH_API}/currency/frankfurter?from=${fromUp}`;
      const r = await fetch(url);
      const data = await r.json();

      if (data.rates && data.rates[toUp]) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  from: fromUp,
                  to: toUp,
                  rate: data.rates[toUp].rate,
                  source: data.source,
                  date: data.date,
                  timestamp: data.timestamp,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Fallback: NBU (via UAH base)
      const urlNbu = `${WATCH_API}/currency/nbu`;
      const rNbu = await fetch(urlNbu);
      const dataNbu = await rNbu.json();

      if (dataNbu.rates && dataNbu.rates[fromUp] && dataNbu.rates[toUp]) {
        const rateFrom = dataNbu.rates[fromUp].rate;
        const rateTo = dataNbu.rates[toUp].rate;
        const crossRate = rateTo / rateFrom;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  from: fromUp,
                  to: toUp,
                  rate: crossRate,
                  source: "NBU (cross-rate via UAH)",
                  date: dataNbu.rates[toUp].date,
                  timestamp: dataNbu.timestamp,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Currency pair not supported", from: fromUp, to: toUp },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_vat_rate",
    "Get VAT rate for a country",
    {
      country: z.string().describe("Country code (e.g. DE, FR, PL)"),
    },
    async ({ country }) => {
      const url = `${WATCH_API}/vat/${country.toUpperCase()}`;
      const r = await fetch(url);
      const data = await r.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_tariff",
    "Get tariff rate for an HS code",
    {
      hs_code: z.string().describe("HS code (e.g. 8471 or 847130)"),
    },
    async ({ hs_code }) => {
      const url = `${WATCH_API}/tariff/${hs_code}`;
      const r = await fetch(url);
      const data = await r.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}

// MCP endpoint (streamable HTTP)
app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (req, res) => {
  res.status(405).json({ error: "Use POST for MCP requests" });
});

app.listen(PORT, () => {
  console.log(`Watch Engine MCP running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP: http://localhost:${PORT}/mcp`);
});