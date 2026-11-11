/**
 * Plugin entry — host half.
 *
 * Responsibilities:
 * 1. report one activity record per finished conversation round,
 * 2. expose the memory tools to the agent,
 * 3. serve the configuration page under `/dsh-brain` (legacy `/cloud-memory` routes stay as aliases).
 *
 * Everything registers through `ctx.effect(...)` so a plugin reload tears down
 * its routes, timer, listeners, and tools without leftovers.
 */
import { CloudClient } from "./api.js";
import { Reporter } from "./reporter.js";
import { createLegacyRoutes, createRoutes } from "./routes.js";
import { join } from 'node:path';
import { SettingsStore, dshHome } from "./store.js";
import { SkillSync, skillsStatePath } from "./skill-sync.js";
import { SkillAdmin, skillsHoldingDir } from "./skill-admin.js";
import { SkillGroupManager, detectSources } from "./skill-groups.js";
import { ClaudePluginMarketplaceProvider, MarketService } from "./market.js";
import { SkillUpdater } from "./skill-update.js";
import { ClientRegistry } from "./clients.js";
import { createMemoryTools, createSkillTools } from "./tools.js";
/** Package name; also the client bundle id. */
export const name = 'dsh-brain';
/** Services required before `apply` runs. */
export const inject = ['webServer'];
/** Version reported by the status card. */
const VERSION = '0.8.1';
/** How often the skill directory is reconciled with the cloud center. */
const SKILL_SYNC_INTERVAL_MS = 15 * 60_000;
/** How often queued reports are retried. */
const RETRY_INTERVAL_MS = 30_000;
/** Register the plugin with the host. */
export function apply(ctx, config) {
    const logger = ctx.logger('dsh-brain');
    const store = new SettingsStore(config);
    const settings = () => store.settings();
    // One client per instance; the settings closures keep it live across edits.
    const client = new CloudClient({
        baseUrl: () => settings().baseUrl,
        token: () => store.memoryToken(),
        timeoutMs: () => settings().requestTimeoutMs,
    });
    const reporter = new Reporter({
        client,
        settings: () => ({ enabled: settings().enabled, clientId: settings().clientId }),
        activityToken: () => store.activityToken(),
        summary: () => ({ enabled: settings().summaryEnabled, maxChars: settings().summaryMaxChars }),
        summaryToken: () => store.summaryToken(),
        log: (message) => logger.warn(message),
    });
    const skillSync = new SkillSync({
        client: () => client,
        settings: () => ({
            enabled: settings().enabled,
            skillsSyncEnabled: settings().skillsSyncEnabled,
            skillsDir: settings().skillsDir,
        }),
        log: (message) => logger.info(message),
        holdingDir: () => skillsHoldingDir(),
    });
    const skillAdmin = new SkillAdmin({
        skillsRoot: () => skillSync.skillsRoot(),
        holdingDir: () => skillsHoldingDir(),
        syncStatePath: () => skillsStatePath(),
        syncRunning: () => skillSync.stats().running,
        log: (message) => logger.info(message),
    });
    // The tree's sources are detected per call so a directory created while the
    // process runs shows up on the next refresh.
    const skillGroups = new SkillGroupManager({
        sources: () => detectSources(),
        admin: skillAdmin,
        log: (message) => logger.info(message),
    });
    // One verified market source to start with: the Claude Code plugin marketplace
    // manifest that Anthropic publishes. Entry ids never carry a URL, so the card
    // cannot make the host fetch an arbitrary repository.
    const market = new MarketService([
        new ClaudePluginMarketplaceProvider({
            id: 'anthropic-skills',
            label: 'Anthropic Agent Skills',
            description: 'Anthropic 公开的 Claude 技能市场（.claude-plugin/marketplace.json）',
            repo: 'anthropics/skills',
            ref: 'main',
        }),
    ]);
    const updater = new SkillUpdater({
        admin: skillAdmin,
        skillsRoot: () => skillSync.skillsRoot(),
        holdingDir: () => skillsHoldingDir(),
        syncRunning: () => skillSync.stats().running,
        log: (message) => logger.info(message),
    });
    // Cross-software / workspace inventory. Read-only for every client except DSH.
    const clients = new ClientRegistry();
    // Announce at most once per activation so a missing token is obvious in logs.
    const effective = settings();
    if (!effective.enabled) {
        logger.info('disabled by settings');
    }
    else if (store.activityToken() === '') {
        logger.warn(`reporting enabled but no activity token; configure one at ${store.path} or open /dsh-brain`);
    }
    else {
        logger.info(`reporting to ${effective.baseUrl} as ${effective.clientId}`);
    }
    if (effective.summaryEnabled && store.summaryToken() === '') {
        logger.info('turn summaries are enabled but no summary token is configured; nothing will be staged');
    }
    // The host's `Events` map is augmented by @deepseek-ai/dsh-session, which a
    // third-party bundle cannot rely on; bind the listener through a local shape.
    const onEvent = ctx.on;
    ctx.effect(() => onEvent('session/event', (session, event) => {
        try {
            reporter.handleEvent(session, event);
        }
        catch (error) {
            logger.warn(`turn event handling failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }), 'dsh-brain: turn reporting');
    ctx.inject(['tools'], (toolsCtx) => {
        const tools = toolsCtx.tools;
        if (tools === undefined)
            return;
        const toolDeps = {
            client: () => client,
            memoryToken: () => store.memoryToken(),
            settings: () => ({ enabled: settings().enabled, defaultK: settings().defaultK }),
        };
        for (const tool of [...createMemoryTools(toolDeps), ...createSkillTools(toolDeps)]) {
            toolsCtx.effect(() => tools.register(tool), `dsh-brain: tool ${tool.name}`);
        }
    });
    const webServer = ctx.webServer;
    if (webServer === undefined) {
        logger.warn('webServer service unavailable; the configuration page stays disabled');
    }
    else {
        const routes = createRoutes({ version: VERSION, store, reporter, client: () => client, skills: () => skillSync.stats(), admin: skillAdmin, groups: skillGroups, market, sync: skillSync, updates: updater, clients });
        routes.push(...createLegacyRoutes({ version: VERSION, store, reporter, client: () => client, skills: () => skillSync.stats(), admin: skillAdmin, groups: skillGroups, market, sync: skillSync, updates: updater, clients }));
        for (const route of routes) {
            ctx.effect(() => webServer.register(route), `dsh-brain: route ${route.path}`);
        }
    }
    ctx.effect(() => {
        const timer = setInterval(() => {
            if (store.activityToken() !== '' && settings().enabled) {
                void reporter.flush().catch((error) => {
                    logger.warn(`retry flush failed: ${error instanceof Error ? error.message : String(error)}`);
                });
            }
        }, RETRY_INTERVAL_MS);
        timer.unref?.();
        return () => clearInterval(timer);
    }, 'dsh-brain: retry timer');
    ctx.effect(() => {
        const run = () => {
            if (store.memoryToken() !== '')
                void skillSync.syncOnce().catch(() => { });
        };
        const first = setTimeout(run, 5_000);
        first.unref?.();
        const timer = setInterval(run, SKILL_SYNC_INTERVAL_MS);
        timer.unref?.();
        return () => { clearTimeout(first); clearInterval(timer); };
    }, 'dsh-brain: skill sync timer');
}
