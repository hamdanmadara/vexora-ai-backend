import type { Request, Response } from "express";
import { featureFlags } from "@/config/env";
import { BadRequestError, FeatureDisabledError } from "@/utils/errors";
import {
  getAnalyticsOverview,
  listAvailablePeriods,
} from "@/services/analytics/analytics.service";
import {
  generateAiReport,
  getSavedReport,
  listSavedReportPeriods,
} from "@/services/analytics/ai-analytics.service";
import { currentPeriod, isValidPeriod } from "@/services/analytics/period";
import { authOf } from "@/middleware/require-auth";

function requirePeriod(raw: unknown): string {
  const period = typeof raw === "string" && raw ? raw : currentPeriod();
  if (!isValidPeriod(period)) {
    throw new BadRequestError(
      "Invalid month. Expected format YYYY-MM (e.g. 2026-08)."
    );
  }
  return period;
}

function ensureDb(): void {
  if (!featureFlags.supabaseReady) throw new FeatureDisabledError("Supabase");
}

/** GET /api/analytics/overview?month=YYYY-MM — deterministic metrics. */
export async function getOverview(req: Request, res: Response): Promise<void> {
  ensureDb();
  const { userId } = authOf(req);
  const period = requirePeriod(req.query.month);
  const overview = await getAnalyticsOverview(period, userId);
  res.json(overview);
}

/**
 * GET /api/analytics/periods — months the picker should offer, plus which of
 * them already have a saved AI report (so the UI can badge them).
 */
export async function getPeriods(req: Request, res: Response): Promise<void> {
  ensureDb();
  const { userId } = authOf(req);
  const [available, withReports] = await Promise.all([
    listAvailablePeriods(userId),
    listSavedReportPeriods(userId),
  ]);

  const current = currentPeriod();
  const periods = available.includes(current)
    ? available
    : [current, ...available];

  res.json({ current, periods, withReports });
}

/** GET /api/analytics/ai?month=YYYY-MM — saved report, or null if never generated. */
export async function getAiReport(req: Request, res: Response): Promise<void> {
  ensureDb();
  const { userId } = authOf(req);
  const period = requirePeriod(req.query.month);
  const report = await getSavedReport(period, userId);
  res.json({ period, report });
}

/**
 * POST /api/analytics/ai — generate (or regenerate) the report for a month.
 * Runs synchronously: the client shows a progress state and the call returns
 * the finished, already-persisted report.
 */
export async function postAiReport(req: Request, res: Response): Promise<void> {
  ensureDb();
  const { userId } = authOf(req);
  const body = (req.body ?? {}) as { month?: string };
  const period = requirePeriod(body.month);
  const report = await generateAiReport(period, userId);
  res.status(201).json({ period, report });
}
