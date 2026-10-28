// node --test: the backup / device-transfer rules of withNoBackupRules (runs in `npm test`).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const withNoBackupRules = require('./withNoBackupRules');

const { DOMAINS, backupRulesXml, dataExtractionRulesXml, setNoBackupRules, writeRuleFiles } =
  withNoBackupRules;

/** Text between `<tag>` and `</tag>` (first occurrence). */
function section(xml, tag) {
  const start = xml.indexOf(`<${tag}>`);
  const end = xml.indexOf(`</${tag}>`);
  assert.ok(start >= 0 && end > start, `<${tag}> present`);
  return xml.slice(start, end);
}

function assertExcludesEverything(block) {
  for (const domain of DOMAINS) {
    assert.ok(block.includes(`<exclude domain="${domain}" path="." />`), `excludes ${domain}`);
  }
  assert.ok(!block.includes('<include'), 'no include rules');
}

const manifest = () => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    queries: [],
    application: [
      { $: { 'android:name': '.MainApplication', 'android:allowBackup': 'false' }, activity: [] },
    ],
  },
});

describe('data_extraction_rules.xml (Android 12+)', () => {
  const xml = dataExtractionRulesXml();

  it('excludes every domain from cloud backup', () => {
    assertExcludesEverything(section(xml, 'cloud-backup'));
  });

  it('excludes every domain from device-to-device transfer (allowBackup=false does not)', () => {
    assertExcludesEverything(section(xml, 'device-transfer'));
  });

  it('is a well-formed data-extraction-rules document', () => {
    assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/);
    assert.equal(xml.trim().split('\n').at(-1), '</data-extraction-rules>');
  });
});

describe('backup_rules.xml (fullBackupContent, API 30 and lower)', () => {
  it('excludes every domain', () => {
    const xml = backupRulesXml();
    assertExcludesEverything(section(xml, 'full-backup-content'));
  });
});

describe('setNoBackupRules', () => {
  it('points <application> at both rule files and keeps the other attributes', () => {
    const out = setNoBackupRules(manifest());
    const app = out.manifest.application[0].$;
    assert.equal(app['android:dataExtractionRules'], '@xml/data_extraction_rules');
    assert.equal(app['android:fullBackupContent'], '@xml/backup_rules');
    assert.equal(app['android:allowBackup'], 'false');
    assert.equal(app['android:name'], '.MainApplication');
  });

  it('is idempotent', () => {
    const once = setNoBackupRules(manifest());
    const twice = setNoBackupRules(structuredClone(once));
    assert.deepEqual(twice, once);
  });

  it('fails loudly without <application>', () => {
    assert.throws(() => setNoBackupRules({ manifest: { $: {}, queries: [] } }));
  });
});

describe('withNoBackupRules (mod wiring)', () => {
  it('writes both XML files under app/src/main/res/xml and patches the manifest', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-backup-'));
    try {
      const config = withNoBackupRules({ name: 'test', slug: 'test' });
      const modRequest = {
        platform: 'android',
        projectRoot: root,
        platformProjectRoot: root,
        introspect: false,
      };
      await config.mods.android.dangerous({ name: 'test', slug: 'test', modRequest });
      const dir = path.join(root, 'app', 'src', 'main', 'res', 'xml');
      assert.equal(
        fs.readFileSync(path.join(dir, 'data_extraction_rules.xml'), 'utf8'),
        dataExtractionRulesXml(),
      );
      assert.equal(fs.readFileSync(path.join(dir, 'backup_rules.xml'), 'utf8'), backupRulesXml());

      const result = await config.mods.android.manifest({
        name: 'test',
        slug: 'test',
        modResults: manifest(),
        modRequest: { ...modRequest, modName: 'manifest' },
      });
      assert.equal(
        result.modResults.manifest.application[0].$['android:dataExtractionRules'],
        '@xml/data_extraction_rules',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writing twice yields the same files (prebuild re-run)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-backup-'));
    try {
      writeRuleFiles(root);
      writeRuleFiles(root);
      const dir = path.join(root, 'app', 'src', 'main', 'res', 'xml');
      assert.deepEqual(fs.readdirSync(dir).sort(), [
        'backup_rules.xml',
        'data_extraction_rules.xml',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
