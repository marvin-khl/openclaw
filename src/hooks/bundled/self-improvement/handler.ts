/**
 * Self-improvement hook handler
 *
 * Analyzes completed sessions for mistakes, learnings, and new rules.
 * Appends findings to memory/retro.md, memory/rules.md, and MEMORY.md.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/self-improvement");

const ANALYSIS_PROMPT = `Analyze this conversation between a user and an AI assistant.
Extract ONLY genuinely new learnings. Be very selective — skip routine interactions.

Return JSON with this exact structure (empty arrays if nothing to learn):
{
  "retros": [
    {
      "title": "Short title of what happened",
      "what_happened": "Brief description",
      "root_cause": "Why it happened",
      "rule": "What to do differently"
    }
  ],
  "rules": [
    "Concise actionable rule learned from this session"
  ],
  "infra_learnings": [
    "New infrastructure/setup fact discovered"
  ]
}

Rules for extraction:
- Only extract if something went WRONG or a DECISION was made
- Skip routine coding, Q&A, or successful straightforward tasks
- A retro needs a real mistake or incident, not just "we did X"
- Rules should be specific and actionable, not generic advice
- Infra learnings are facts about the system setup (URLs, configs, deploy processes)
- Return empty arrays if nothing notable happened
- Be brief — each entry should be 1-2 sentences max`;

/**
 * Read recent messages from session file
 */
async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 30,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");
    const allMessages: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) continue;
            const text = Array.isArray(msg.content)
              ? msg.content.find((c: { type: string; text?: string }) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              allMessages.push(`${role}: ${text.slice(0, 500)}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return allMessages.slice(-messageCount).join("\n");
  } catch {
    return null;
  }
}

/**
 * Try active transcript, fallback to reset sibling
 */
async function getContentWithResetFallback(
  sessionFilePath: string,
  messageCount: number,
): Promise<string | null> {
  const primary = await getRecentSessionContent(sessionFilePath, messageCount);
  if (primary) return primary;

  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resets = files.filter((n) => n.startsWith(resetPrefix)).toSorted();
    if (resets.length === 0) return primary;

    return await getRecentSessionContent(path.join(dir, resets[resets.length - 1]), messageCount);
  } catch {
    return primary;
  }
}

/**
 * Call LLM to analyze session content
 */
async function analyzeSession(
  sessionContent: string,
  cfg: OpenClawConfig,
): Promise<{
  retros: Array<{ title: string; what_happened: string; root_cause: string; rule: string }>;
  rules: string[];
  infra_learnings: string[];
} | null> {
  try {
    // Dynamic import to avoid circular dependencies
    const { callLLMForJSON } = await import("../../llm-slug-generator.js");
    const result = await callLLMForJSON({
      cfg,
      systemPrompt: ANALYSIS_PROMPT,
      userPrompt: sessionContent.slice(0, 8000), // Limit context
    });
    return result as {
      retros: Array<{ title: string; what_happened: string; root_cause: string; rule: string }>;
      rules: string[];
      infra_learnings: string[];
    };
  } catch (err) {
    log.error("LLM analysis failed", { error: String(err) });
    return null;
  }
}

/**
 * Append learnings to memory files
 */
async function appendLearnings(
  workspaceDir: string,
  analysis: {
    retros: Array<{ title: string; what_happened: string; root_cause: string; rule: string }>;
    rules: string[];
    infra_learnings: string[];
  },
): Promise<string[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  const dateStr = new Date().toISOString().split("T")[0];
  const updates: string[] = [];

  // Append retros
  if (analysis.retros.length > 0) {
    const retroPath = path.join(memoryDir, "retro.md");
    let retroContent = "";
    for (const r of analysis.retros) {
      retroContent += `\n## ${dateStr} — ${r.title}\n\n`;
      retroContent += `**Was passiert:** ${r.what_happened}\n`;
      retroContent += `**Root Cause:** ${r.root_cause}\n`;
      retroContent += `**Regel:** ${r.rule}\n`;
    }
    await fs.appendFile(retroPath, retroContent);
    updates.push(`${analysis.retros.length} retro(s) → memory/retro.md`);
  }

  // Append rules
  if (analysis.rules.length > 0) {
    const rulesPath = path.join(memoryDir, "rules.md");
    let rulesContent = "\n## Auto-extracted\n\n";
    for (const rule of analysis.rules) {
      rulesContent += `- ${rule}\n`;
    }
    await fs.appendFile(rulesPath, rulesContent);
    updates.push(`${analysis.rules.length} rule(s) → memory/rules.md`);
  }

  // Append infra learnings
  if (analysis.infra_learnings.length > 0) {
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    let infraContent = "\n## Auto-discovered\n\n";
    for (const learning of analysis.infra_learnings) {
      infraContent += `- ${learning}\n`;
    }
    await fs.appendFile(memoryPath, infraContent);
    updates.push(`${analysis.infra_learnings.length} infra learning(s) → MEMORY.md`);
  }

  return updates;
}

const selfImprovement: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    log.debug("Self-improvement hook triggered", { action: event.action });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    if (!cfg) {
      log.debug("No config available, skipping");
      return;
    }

    // Skip in test environments
    const isTestEnv =
      process.env.OPENCLAW_TEST_FAST === "1" ||
      process.env.VITEST === "true" ||
      process.env.NODE_ENV === "test";
    if (isTestEnv) return;

    const contextWorkspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
        : undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir =
      contextWorkspaceDir ||
      (cfg
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : path.join(resolveStateDir(process.env, os.homedir), "workspace"));

    // Find session file
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const sessionFile = (sessionEntry.sessionFile as string) || undefined;
    if (!sessionFile) {
      log.debug("No session file found, skipping");
      return;
    }

    // Read session content
    const hookConfig = resolveHookConfig(cfg, "self-improvement");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 30;

    const sessionContent = await getContentWithResetFallback(sessionFile, messageCount);
    if (!sessionContent || sessionContent.length < 200) {
      log.debug("Session too short for analysis, skipping");
      return;
    }

    // Analyze with LLM
    const analysis = await analyzeSession(sessionContent, cfg);
    if (!analysis) return;

    const hasLearnings =
      analysis.retros.length > 0 ||
      analysis.rules.length > 0 ||
      analysis.infra_learnings.length > 0;

    if (!hasLearnings) {
      log.debug("No learnings extracted, skipping write");
      return;
    }

    // Write learnings
    const updates = await appendLearnings(workspaceDir, analysis);
    log.info(`Self-improvement: ${updates.join(", ")}`);
  } catch (err) {
    log.error("Self-improvement hook failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default selfImprovement;
