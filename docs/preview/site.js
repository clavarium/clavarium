/* One shared snippet: the site map. It is the home's main visual ([data-map])
   and the menu on every page (the "Menu" button opens it in a dialog).
   Green = feature, orange = use case. "#soon" = page not built yet. */
(function () {
  var F = [
    ['Isolated agents', 'isolated-agents.html', 'One VM per agent, or several in one.', 'VMs', 'VMs'],
    ['Keys & assets', 'assets-and-keys.html', 'Keys, folders, accounts: given per agent, taken back.', 'secrets, folders'],
    ['Chat from anywhere', 'parley.html', 'Chat with your agents from your phone.', 'Parley', 'Parley'],
    ['Connect your tools', 'tether.html', 'Mail, calendar, browser, files, MCP.', 'Tether', 'Tether'],
    ['Talk from any room', 'voice-boxes.html', 'Talk to your AI from any room.', 'Voice boxes', 'Voice boxes'],
    ['Agents work together', 'rooms.html', 'Several AIs in one room, hand-overs capped.', 'Rooms', 'Rooms']
  ];
  var U = [
    ['Family', 'family.html', 'Marcel, 82, talks to a box at home.'],
    ['Coding agents', 'coding-agents.html', 'Several agents in parallel, you review.'],
    ['Data sovereignty', 'data-sovereignty.html', 'Your server, a European AI provider.'],
    ['Home and voice', 'home-and-voice.html', 'A voice assistant that runs at home.'],
    ['Mail & calendar assistant', 'mail-and-calendar.html', 'It drafts; you approve what goes out.'],
    ['Team or office', 'team-and-office.html', 'One agent per client, shared by QR code.']
  ];
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function col(kind, label, items) {
    var c = el('nav', 'col ' + kind);
    c.setAttribute('aria-label', label);
    c.appendChild(el('p', 'lbl', label));
    items.forEach(function (it) {
      var a = el('a');
      a.href = it[1];
      a.title = it[2];
      var t = el('span', 'nm', it[0]);
      if (it[3]) t.appendChild(el('small', 'cmp', it[3]));
      if (it[4]) t.appendChild(el('small', 'cs', ' · ' + it[4]));
      a.appendChild(t);
      a.appendChild(el('span', 'go', '↗'));
      a.appendChild(el('span', 'tip', it[2]));
      c.appendChild(a);
    });
    return c;
  }
  function map() {
    var m = el('div', 'map');
    m.appendChild(col('f', 'Features', F));
    var hub = el('div', 'hub');
    var srv = el('div', 'srv');
    srv.appendChild(el('b', '', 'Your server'));
    var ag = el('div', 'agents');
    ['Claude Code', 'Codex', 'OpenCode'].forEach(function (n) { ag.appendChild(el('span', '', n)); });
    srv.appendChild(ag);
    hub.appendChild(srv);
    m.appendChild(hub);
    m.appendChild(col('u', 'Use cases', U));
    var foot = el('nav', 'foot');
    foot.setAttribute('aria-label', 'Start here');
    [['FAQ', 'faq.html'], ['Security', 'security.html']].forEach(function (l) { var a = el('a', '', l[0]); a.href = l[1]; foot.appendChild(a); });
    m.appendChild(foot);
    return m;
  }
  document.querySelectorAll('[data-map]').forEach(function (h) { h.appendChild(map()); });

  /* the menu: the same map, plus the secondary pages */
  var dlg = el('dialog', 'mapdlg');
  dlg.setAttribute('aria-label', 'Site map');
  var bar = el('div', 'bar');
  bar.appendChild(el('b', '', 'Site map'));
  var x = el('button', 'x', '×');
  x.setAttribute('aria-label', 'Close');
  x.onclick = function () { dlg.close(); };
  bar.appendChild(x);
  dlg.appendChild(bar);
  dlg.appendChild(map());
  var row = el('nav', 'maprow');
  [['Home', 'index.html'], ['Install', 'install.html'], ['Roadmap', 'roadmap.html'], ['GitHub', 'https://github.com/clavarium/clavarium']]
    .forEach(function (l) { var a = el('a', '', l[0]); a.href = l[1]; row.appendChild(a); });
  dlg.appendChild(row);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  document.body.appendChild(dlg);
  document.querySelectorAll('[data-open-map]').forEach(function (b) {
    b.onclick = function () { dlg.showModal(); };
  });

  /* copy buttons */
  document.querySelectorAll('.cmd button').forEach(function (b) {
    b.onclick = function () {
      var t = b.parentNode.querySelector('code').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
        function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); },
        function () { b.textContent = 'Select it'; });
    };
  });
})();
