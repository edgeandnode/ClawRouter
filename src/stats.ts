/**
 * Usage Statistics Aggregator
 *
 * Reads usage log files and aggregates statistics for dashboard display.
 * Supports filtering by date range and provides multiple aggregation views.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageEntry } from "./logger.js";

const LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");

export type DailyStats = {
  date: string;
  totalRequests: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavings: number;
  avgLatencyMs: number;
  byTier: Record<string, { count: number; cost: number }>;
  byModel: Record<string, { count: number; cost: number }>;
};

export type AggregatedStats = {
  period: string;
  totalRequests: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavings: number;
  savingsPercentage: number;
  avgLatencyMs: number;
  avgCostPerRequest: number;
  byTier: Record<string, { count: number; cost: number; percentage: number }>;
  byModel: Record<string, { count: number; cost: number; percentage: number }>;
  dailyBreakdown: DailyStats[];
};

/**
 * Parse a JSONL log file into usage entries.
 * Handles both old format (without tier/baselineCost) and new format.
 */
async function parseLogFile(filePath: string): Promise<UsageEntry[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const entry = JSON.parse(line) as Partial<UsageEntry>;
      // Handle old format entries
      return {
        timestamp: entry.timestamp || new Date().toISOString(),
        model: entry.model || "unknown",
        tier: entry.tier || "UNKNOWN",
        cost: entry.cost || 0,
        baselineCost: entry.baselineCost || entry.cost || 0,
        savings: entry.savings || 0,
        latencyMs: entry.latencyMs || 0,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get list of available log files sorted by date (newest first).
 */
async function getLogFiles(): Promise<string[]> {
  try {
    const files = await readdir(LOG_DIR);
    return files
      .filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Aggregate stats for a single day.
 */
function aggregateDay(date: string, entries: UsageEntry[]): DailyStats {
  const byTier: Record<string, { count: number; cost: number }> = {};
  const byModel: Record<string, { count: number; cost: number }> = {};
  let totalLatency = 0;

  for (const entry of entries) {
    // By tier
    if (!byTier[entry.tier]) byTier[entry.tier] = { count: 0, cost: 0 };
    byTier[entry.tier].count++;
    byTier[entry.tier].cost += entry.cost;

    // By model
    if (!byModel[entry.model]) byModel[entry.model] = { count: 0, cost: 0 };
    byModel[entry.model].count++;
    byModel[entry.model].cost += entry.cost;

    totalLatency += entry.latencyMs;
  }

  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const totalBaselineCost = entries.reduce((sum, e) => sum + e.baselineCost, 0);

  return {
    date,
    totalRequests: entries.length,
    totalCost,
    totalBaselineCost,
    totalSavings: totalBaselineCost - totalCost,
    avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
    byTier,
    byModel,
  };
}

/**
 * Get aggregated statistics for the last N days.
 */
export async function getStats(days: number = 7): Promise<AggregatedStats> {
  const logFiles = await getLogFiles();
  const filesToRead = logFiles.slice(0, days);

  const dailyBreakdown: DailyStats[] = [];
  const allByTier: Record<string, { count: number; cost: number }> = {};
  const allByModel: Record<string, { count: number; cost: number }> = {};
  let totalRequests = 0;
  let totalCost = 0;
  let totalBaselineCost = 0;
  let totalLatency = 0;

  for (const file of filesToRead) {
    const date = file.replace("usage-", "").replace(".jsonl", "");
    const filePath = join(LOG_DIR, file);
    const entries = await parseLogFile(filePath);

    if (entries.length === 0) continue;

    const dayStats = aggregateDay(date, entries);
    dailyBreakdown.push(dayStats);

    totalRequests += dayStats.totalRequests;
    totalCost += dayStats.totalCost;
    totalBaselineCost += dayStats.totalBaselineCost;
    totalLatency += dayStats.avgLatencyMs * dayStats.totalRequests;

    // Merge tier stats
    for (const [tier, stats] of Object.entries(dayStats.byTier)) {
      if (!allByTier[tier]) allByTier[tier] = { count: 0, cost: 0 };
      allByTier[tier].count += stats.count;
      allByTier[tier].cost += stats.cost;
    }

    // Merge model stats
    for (const [model, stats] of Object.entries(dayStats.byModel)) {
      if (!allByModel[model]) allByModel[model] = { count: 0, cost: 0 };
      allByModel[model].count += stats.count;
      allByModel[model].cost += stats.cost;
    }
  }

  // Calculate percentages
  const byTierWithPercentage: Record<string, { count: number; cost: number; percentage: number }> =
    {};
  for (const [tier, stats] of Object.entries(allByTier)) {
    byTierWithPercentage[tier] = {
      ...stats,
      percentage: totalRequests > 0 ? (stats.count / totalRequests) * 100 : 0,
    };
  }

  const byModelWithPercentage: Record<string, { count: number; cost: number; percentage: number }> =
    {};
  for (const [model, stats] of Object.entries(allByModel)) {
    byModelWithPercentage[model] = {
      ...stats,
      percentage: totalRequests > 0 ? (stats.count / totalRequests) * 100 : 0,
    };
  }

  const totalSavings = totalBaselineCost - totalCost;
  const savingsPercentage = totalBaselineCost > 0 ? (totalSavings / totalBaselineCost) * 100 : 0;

  return {
    period: days === 1 ? "today" : `last ${days} days`,
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    savingsPercentage,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    byTier: byTierWithPercentage,
    byModel: byModelWithPercentage,
    dailyBreakdown: dailyBreakdown.reverse(), // Oldest first for charts
  };
}

/**
 * Format stats as ASCII table for terminal display.
 */
export function formatStatsAscii(stats: AggregatedStats): string {
  const lines: string[] = [];

  // Header
  lines.push("╔════════════════════════════════════════════════════════════╗");
  lines.push("║              ClawRouter Usage Statistics                   ║");
  lines.push("╠════════════════════════════════════════════════════════════╣");

  // Summary
  lines.push(`║  Period: ${stats.period.padEnd(49)}║`);
  lines.push(`║  Total Requests: ${stats.totalRequests.toString().padEnd(41)}║`);
  lines.push(`║  Total Cost: $${stats.totalCost.toFixed(4).padEnd(43)}║`);
  lines.push(
    `║  Baseline Cost (Opus): $${stats.totalBaselineCost.toFixed(4).padEnd(33)}║`,
  );
  lines.push(
    `║  💰 Total Saved: $${stats.totalSavings.toFixed(4)} (${stats.savingsPercentage.toFixed(1)}%)`.padEnd(61) + "║",
  );
  lines.push(`║  Avg Latency: ${stats.avgLatencyMs.toFixed(0)}ms`.padEnd(61) + "║");

  // Tier breakdown
  lines.push("╠════════════════════════════════════════════════════════════╣");
  lines.push("║  Routing by Tier:                                          ║");

  const tierOrder = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
  for (const tier of tierOrder) {
    const data = stats.byTier[tier];
    if (data) {
      const bar = "█".repeat(Math.min(20, Math.round(data.percentage / 5)));
      const line = `║    ${tier.padEnd(10)} ${bar.padEnd(20)} ${data.percentage.toFixed(1).padStart(5)}% (${data.count})`;
      lines.push(line.padEnd(61) + "║");
    }
  }

  // Top models
  lines.push("╠════════════════════════════════════════════════════════════╣");
  lines.push("║  Top Models:                                               ║");

  const sortedModels = Object.entries(stats.byModel)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  for (const [model, data] of sortedModels) {
    const shortModel = model.length > 25 ? model.slice(0, 22) + "..." : model;
    const line = `║    ${shortModel.padEnd(25)} ${data.count.toString().padStart(5)} reqs  $${data.cost.toFixed(4)}`;
    lines.push(line.padEnd(61) + "║");
  }

  // Daily breakdown (last 7 days)
  if (stats.dailyBreakdown.length > 0) {
    lines.push("╠════════════════════════════════════════════════════════════╣");
    lines.push("║  Daily Breakdown:                                          ║");
    lines.push("║    Date        Requests    Cost      Saved                 ║");

    for (const day of stats.dailyBreakdown.slice(-7)) {
      const saved = day.totalBaselineCost - day.totalCost;
      const line = `║    ${day.date}   ${day.totalRequests.toString().padStart(6)}    $${day.totalCost.toFixed(4).padStart(8)}  $${saved.toFixed(4)}`;
      lines.push(line.padEnd(61) + "║");
    }
  }

  lines.push("╚════════════════════════════════════════════════════════════╝");

  return lines.join("\n");
}

/**
 * Generate HTML dashboard page.
 */
export function generateDashboardHtml(stats: AggregatedStats): string {
  const tierData = Object.entries(stats.byTier).map(([tier, data]) => ({
    tier,
    count: data.count,
    percentage: data.percentage.toFixed(1),
  }));

  const modelData = Object.entries(stats.byModel)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([model, data]) => ({
      model: model.split("/").pop() || model,
      count: data.count,
      cost: data.cost.toFixed(4),
    }));

  const dailyData = stats.dailyBreakdown.map((day) => ({
    date: day.date,
    cost: day.totalCost.toFixed(4),
    saved: (day.totalBaselineCost - day.totalCost).toFixed(4),
    requests: day.totalRequests,
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawRouter Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      padding: 2rem;
    }
    .header {
      text-align: center;
      margin-bottom: 2rem;
    }
    .header h1 {
      font-size: 2.5rem;
      background: linear-gradient(90deg, #f39c12, #e74c3c);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    .header p { color: #888; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1.5rem;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .stat-card .value {
      font-size: 2rem;
      font-weight: bold;
      color: #f39c12;
    }
    .stat-card .label {
      color: #888;
      font-size: 0.9rem;
      margin-top: 0.5rem;
    }
    .stat-card.savings .value { color: #2ecc71; }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 2rem;
    }
    .chart-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1.5rem;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .chart-card h3 {
      margin-bottom: 1rem;
      color: #fff;
    }
    canvas { max-height: 300px; }
    .table-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1.5rem;
      border: 1px solid rgba(255,255,255,0.1);
      margin-top: 2rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 0.75rem;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    th { color: #888; font-weight: 500; }
    .refresh-note {
      text-align: center;
      color: #666;
      font-size: 0.85rem;
      margin-top: 2rem;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>ClawRouter Dashboard</h1>
    <p>Smart LLM Routing Analytics • ${stats.period}</p>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="value">${stats.totalRequests.toLocaleString()}</div>
      <div class="label">Total Requests</div>
    </div>
    <div class="stat-card">
      <div class="value">$${stats.totalCost.toFixed(2)}</div>
      <div class="label">Total Cost</div>
    </div>
    <div class="stat-card savings">
      <div class="value">$${stats.totalSavings.toFixed(2)}</div>
      <div class="label">Total Saved</div>
    </div>
    <div class="stat-card savings">
      <div class="value">${stats.savingsPercentage.toFixed(1)}%</div>
      <div class="label">Savings Rate</div>
    </div>
    <div class="stat-card">
      <div class="value">${stats.avgLatencyMs.toFixed(0)}ms</div>
      <div class="label">Avg Latency</div>
    </div>
    <div class="stat-card">
      <div class="value">$${(stats.avgCostPerRequest * 1000).toFixed(2)}</div>
      <div class="label">Cost per 1K Requests</div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <h3>Routing by Tier</h3>
      <canvas id="tierChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Daily Cost vs Savings</h3>
      <canvas id="dailyChart"></canvas>
    </div>
  </div>

  <div class="table-card">
    <h3>Top Models by Usage</h3>
    <table>
      <thead>
        <tr><th>Model</th><th>Requests</th><th>Cost</th></tr>
      </thead>
      <tbody>
        ${modelData.map((m) => `<tr><td>${m.model}</td><td>${m.count}</td><td>$${m.cost}</td></tr>`).join("")}
      </tbody>
    </table>
  </div>

  <p class="refresh-note">Auto-refreshes every 30 seconds • Data from usage logs</p>

  <script>
    const tierData = ${JSON.stringify(tierData)};
    const dailyData = ${JSON.stringify(dailyData)};

    // Tier pie chart
    new Chart(document.getElementById('tierChart'), {
      type: 'doughnut',
      data: {
        labels: tierData.map(d => d.tier),
        datasets: [{
          data: tierData.map(d => d.count),
          backgroundColor: ['#3498db', '#f39c12', '#e74c3c', '#9b59b6'],
          borderWidth: 0
        }]
      },
      options: {
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#fff' }
          }
        }
      }
    });

    // Daily bar chart
    new Chart(document.getElementById('dailyChart'), {
      type: 'bar',
      data: {
        labels: dailyData.map(d => d.date.slice(5)),
        datasets: [
          {
            label: 'Cost',
            data: dailyData.map(d => parseFloat(d.cost)),
            backgroundColor: '#e74c3c'
          },
          {
            label: 'Saved',
            data: dailyData.map(d => parseFloat(d.saved)),
            backgroundColor: '#2ecc71'
          }
        ]
      },
      options: {
        scales: {
          x: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.1)' } },
          y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.1)' } }
        },
        plugins: {
          legend: { labels: { color: '#fff' } }
        }
      }
    });

    // Auto-refresh
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`;
}
