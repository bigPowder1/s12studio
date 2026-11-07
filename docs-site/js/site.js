// S12 Studio download site. Progressive enhancement only: every link works without JavaScript.
//
// The ONE place to set the GitHub repository. The Pages workflow (.github/workflows/pages.yml) also replaces the
// placeholder (OWNER + "/s12studio") in every file with the repository it deploys from, so normally nothing needs editing.
const S12_REPO = 'bigPowder1/s12studio';

(function () {
  'use strict';
  // Split so the deploy-time substitution of the placeholder does not rewrite this comparison value.
  const PLACEHOLDER = 'OWNER' + '/s12studio';
  const repo = S12_REPO;

  // 1. Point every placeholder link at the configured repository.
  if (repo !== PLACEHOLDER) {
    document.querySelectorAll('a[href*="' + PLACEHOLDER + '"]').forEach(function (a) {
      a.href = a.getAttribute('href').split(PLACEHOLDER).join(repo);
    });
  }

  // 2. Detect the visitor's OS and put the matching download first.
  function detectOs() {
    const uaData = navigator.userAgentData;
    const p = ((uaData && uaData.platform) || navigator.platform || '').toLowerCase();
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|android/.test(ua)) return 'mobile';
    if (p.indexOf('win') === 0 || ua.indexOf('windows') >= 0) return 'windows';
    if (p.indexOf('mac') === 0 || ua.indexOf('mac os') >= 0) return 'mac';
    if (p.indexOf('linux') >= 0 || ua.indexOf('linux') >= 0) return 'linux';
    return 'unknown';
  }

  const os = detectOs();
  const list = document.querySelector('[data-downloads]');
  const note = document.querySelector('[data-os-note]');
  if (list) {
    const items = Array.prototype.slice.call(list.querySelectorAll('[data-os]'));
    const match = items.filter(function (li) { return li.getAttribute('data-os') === os; });
    match.forEach(function (li) {
      li.classList.add('recommended');
      list.insertBefore(li, list.firstChild);
    });
    if (note) {
      const names = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
      // Only the <span data-os-note> text changes; the "latest release page" link after it stays.
      if (names[os]) note.textContent = 'Detected ' + names[os] + ': its download is first.';
      else if (os === 'mobile') note.textContent = 'S12 Studio is a desktop app: download it on a Windows, Mac or Linux computer.';
    }
  }

  // Chromium can tell Apple Silicon from Intel; Safari cannot (both report "Intel"), so arm64 stays the default.
  if (os === 'mac' && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['architecture']).then(function (v) {
      if (v.architecture === 'x86') {
        const intel = document.querySelector('[data-os="mac"][data-arch="x64"]');
        const arm = document.querySelector('[data-os="mac"][data-arch="arm64"]');
        if (intel && arm && list) {
          arm.classList.remove('recommended');
          list.insertBefore(intel, list.firstChild);
        }
      }
    }).catch(function () {});
  }

  // 3. Turn the buttons into direct downloads of the latest release, when the GitHub API answers.
  if (repo === PLACEHOLDER || !window.fetch) return;
  fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      if (!rel || !rel.assets) return;
      const pick = function (re) {
        const a = rel.assets.filter(function (x) { return re.test(x.name); })[0];
        return a ? a.browser_download_url : null;
      };
      const urls = {
        windows: pick(/\.exe$/i),
        'mac-arm64': pick(/arm64.*\.dmg$/i),
        'mac-x64': pick(/^(?!.*arm64).*\.dmg$/i),
        linux: pick(/\.AppImage$/i),
      };
      document.querySelectorAll('[data-os] a.download').forEach(function (a) {
        const li = a.closest('[data-os]');
        const key = li.getAttribute('data-os') + (li.getAttribute('data-arch') ? '-' + li.getAttribute('data-arch') : '');
        if (urls[key]) a.href = urls[key];
      });
      document.querySelectorAll('[data-version]').forEach(function (el) {
        el.textContent = 'Latest version: ' + rel.tag_name;
      });
    })
    .catch(function () { /* keep the release-page links */ });

})();
