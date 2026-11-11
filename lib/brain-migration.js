/**
 * dsh-cloud-memory → dsh-brain naming migration (v1.1 §15.1, RENAME-01).
 *
 * The 0.8.0 unification build ships AS `dsh-brain`: the package rename
 * (the deploy step RENAME-01 deferred) has been performed, and the load
 * paths read the `dsh-brain` names. What is implemented here is the
 * *data* half, which is what RENAME-01 asserts:
 *
 *  - copy the legacy sidecars to the `dsh-brain` names when the target is
 *    missing, never deleting or modifying the legacy files;
 *  - be idempotent: a second run is a no-op;
 *  - report what exists so the caller can drive the load-path switch safely.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dshHome } from "./store.js";
export const BRAIN = {
    product: 'DSH Brain',
    targetPackage: 'dsh-brain',
    legacyPackage: 'dsh-cloud-memory',
};
/** Legacy sidecar → new-sidecar file name pairs. */
const PAIRS = [
    ['cloud-memory.json', 'dsh-brain.json'],
    ['cloud-memory-skills.json', 'dsh-brain-skills.json'],
    ['cloud-memory-skill-groups.json', 'dsh-brain-skill-groups.json'],
    ['cloud-memory-workspaces.json', 'dsh-brain-workspaces.json'],
    ['.cloud-memory-plans.json', '.dsh-brain-plans.json'],
];
async function exists(path) {
    return stat(path).then((value) => value.isFile()).catch(() => false);
}
export async function brainStatus() {
    const home = dshHome();
    const files = [];
    for (const [legacyName, targetName] of PAIRS) {
        const legacy = join(home, legacyName);
        const target = join(home, targetName);
        const legacyExists = await exists(legacy);
        const targetExists = await exists(target);
        files.push({ legacy, target, legacyExists, targetExists, needsMigration: legacyExists && !targetExists });
    }
    return {
        home,
        product: BRAIN.product,
        targetPackage: BRAIN.targetPackage,
        legacyPackage: BRAIN.legacyPackage,
        files,
        migrationNeeded: files.some((file) => file.needsMigration),
        packageRename: 'done',
    };
}
/** Copy legacy sidecars to the new names. Existing targets are never overwritten. */
export async function migrateLegacyFiles() {
    const home = dshHome();
    const copied = [];
    const skipped = [];
    for (const [legacyName, targetName] of PAIRS) {
        const legacy = join(home, legacyName);
        const target = join(home, targetName);
        if (!(await exists(legacy)))
            continue;
        if (await exists(target)) {
            skipped.push(targetName);
            continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await copyFile(legacy, target);
        copied.push(targetName);
    }
    return { home, copied, skipped, product: BRAIN.product, targetPackage: BRAIN.targetPackage, legacyPackage: BRAIN.legacyPackage };
}
