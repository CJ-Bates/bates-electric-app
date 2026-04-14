/**
 * Bates Electric Safety Hub — Games
 * Wire Wizard: Puzzle game to learn wire colors
 * Hazard Quiz: Safety knowledge quiz
 */

let currentGame = null;
let gameAnimFrame = null;
const HIGH_SCORES = JSON.parse(localStorage.getItem('beGameScores') || '{}');

// Sync existing scores to leaderboard on startup
(function() {
  var pname = '';
  try { pname = localStorage.getItem('bePlayerName') || ''; } catch(e) {}
  if (pname) {
    ['wirewizard','hazardquiz'].forEach(function(g) {
      if (HIGH_SCORES[g]) { pushLeaderboard(g, HIGH_SCORES[g], pname); }
    });
  }
})();

// Initialize UI on page load
document.addEventListener('DOMContentLoaded', function() {
  renderHighScores();
  loadLeaderboard();
  updateScoreBadges();
});

function updateScoreBadges() {
  const wwScore = HIGH_SCORES.wirewizard;
  const hqScore = HIGH_SCORES.hazardquiz;
  document.getElementById('ww-best-score').textContent = wwScore ? wwScore.toLocaleString() + ' pts' : '—';
  document.getElementById('hq-best-score').textContent = hqScore ? hqScore.toLocaleString() + ' pts' : '—';
}

// ═══════════════════════════════════════
// HIGH SCORE & LEADERBOARD MANAGEMENT
// ═══════════════════════════════════════

function saveHighScore(game, score) {
  var isNew = !HIGH_SCORES[game] || score > HIGH_SCORES[game];
  if (isNew) {
    HIGH_SCORES[game] = score;
    try { localStorage.setItem('beGameScores', JSON.stringify(HIGH_SCORES)); } catch(e) {}
  }
  // Always try to push - pushLeaderboard keeps only best score per player
  var pname = '';
  try { pname = localStorage.getItem('bePlayerName') || ''; } catch(e) {}
  if (pname) {
    // Push current best (not just this score) so name changes sync too
    pushLeaderboard(game, HIGH_SCORES[game], pname);
  } else if (isNew) {
    promptNameLB(game, HIGH_SCORES[game]);
  }
  updateScoreBadges();
}

function promptNameLB(game, score) {
  if (document.getElementById('namePrompt')) return; // already showing
  var d = document.createElement('div');
  d.id = 'namePrompt';
  d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.80);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;';
  var inner = document.createElement('div');
  inner.style.cssText = 'background:rgba(255,255,255,0.99);border:0.5px solid rgba(30,58,110,0.20);border-radius:20px;padding:28px;width:100%;max-width:320px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3);';
  inner.innerHTML = '<div style="font-size:40px;margin-bottom:8px;">&#127942;</div>'
    + '<div style="font-size:20px;font-weight:800;color:#0F1F3D;margin-bottom:4px;">New High Score!</div>'
    + '<div style="font-size:15px;font-weight:700;color:#B45309;margin-bottom:4px;">' + score.toLocaleString() + ' pts</div>'
    + '<div style="font-size:13px;color:rgba(15,31,61,0.55);margin-bottom:16px;">Enter your name to post to the global leaderboard</div>'
    + '<input id="lbNameInput" type="text" maxlength="20" placeholder="Your name..." style="width:100%;padding:13px;background:rgba(30,58,110,0.06);border:1px solid rgba(30,58,110,0.20);border-radius:10px;color:#0F1F3D;font-size:16px;font-family:inherit;outline:none;box-sizing:border-box;margin-bottom:12px;">'
    + '<button id="lbSubBtn" style="width:100%;padding:14px;background:linear-gradient(135deg,#1A5CB8,#1E3A6E);border:none;border-radius:10px;color:white;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:8px;">Post to Leaderboard</button>'
    + '<button id="lbAnonBtn" style="width:100%;padding:10px;background:none;border:none;color:rgba(15,31,61,0.40);font-size:13px;cursor:pointer;font-family:inherit;">Post as Anonymous</button>';
  d.appendChild(inner);
  document.body.appendChild(d);
  document.getElementById('lbSubBtn').onclick = function() { submitLBName(game, score); };
  document.getElementById('lbAnonBtn').onclick = function() {
    var el = document.getElementById('namePrompt'); if(el) el.remove();
    pushLeaderboard(game, score, 'Anonymous');
  };
  var inp = document.getElementById('lbNameInput');
  if (inp) {
    inp.addEventListener('keydown', function(e) { if(e.key==='Enter') submitLBName(game,score); });
    setTimeout(function() { inp.focus(); }, 150);
  }
}

window.submitLBName = function(game, score) {
  var input = document.getElementById('lbNameInput');
  var name = (input ? input.value.trim() : '') || 'Anonymous';
  try { localStorage.setItem('bePlayerName', name); } catch(e) {}
  var d = document.getElementById('namePrompt'); if(d) d.remove();
  pushLeaderboard(game, score, name);
  renderHighScores();
  loadLeaderboard();
};

async function pushLeaderboard(game, score, name) {
  try {
    var lb = {};
    try { lb = JSON.parse(localStorage.getItem('beLeaderboard') || '{}'); } catch(e) {}
    if (!lb[game]) lb[game] = [];
    // Remove old entry for this player
    lb[game] = lb[game].filter(function(e){ return e.name !== name; });
    lb[game].push({name:name, score:score, ts:Date.now()});
    lb[game] = lb[game].sort(function(a,b){return b.score-a.score;}).slice(0,20);
    localStorage.setItem('beLeaderboard', JSON.stringify(lb));
    // Also try remote sync (best effort - may fail due to CORS on some browsers)
    try {
      fetch('https://www.jsonstore.io/bates-electric-safety-hub-leaderboard-2025-ce7f4a2b/scores', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(lb)
      });
    } catch(e) {}
    loadLeaderboard();
  } catch(e) { console.warn('pushLeaderboard error:', e); }
}

async function loadLeaderboard() {
  var el = document.getElementById('globalLeaderboard');
  if (!el) return;
  // Read from localStorage (always works)
  var lb = {};
  try { lb = JSON.parse(localStorage.getItem('beLeaderboard') || '{}'); } catch(e) {}
  // Also try remote (best effort)
  try {
    var res = await Promise.race([
      fetch('https://www.jsonstore.io/bates-electric-safety-hub-leaderboard-2025-ce7f4a2b/scores', {cache:'no-store'}),
      new Promise(function(_,r){setTimeout(function(){r(new Error('timeout'));},3000);})
    ]);
    if (res && res.ok) {
      var data = await res.json();
      if (data && data.result && typeof data.result === 'object') {
        // Merge remote scores with local - keep best per player
        ['wirewizard','hazardquiz'].forEach(function(g) {
          var remote = data.result[g] || [];
          var local = lb[g] || [];
          var merged = {};
          local.concat(remote).forEach(function(e) {
            if (!e || !e.name) return;
            if (!merged[e.name] || e.score > merged[e.name].score) merged[e.name] = e;
          });
          lb[g] = Object.values(merged).sort(function(a,b){return b.score-a.score;}).slice(0,20);
        });
        localStorage.setItem('beLeaderboard', JSON.stringify(lb));
      }
    }
  } catch(e) {}
  renderLeaderboard(lb);
}

function renderLeaderboard(lb) {
  var el = document.getElementById('globalLeaderboard');
  if (!el) return;
  var gN = {wirewizard:'Wire Wizard', hazardquiz:'Hazard Quiz'};
  var games = ['wirewizard','hazardquiz'];
  var myName = '';
  try { myName = localStorage.getItem('bePlayerName') || ''; } catch(e) {}
  var medals = ['🥇','🥈','🥉'];
  var out = '', anyScores = false;
  games.forEach(function(g) {
    var entries = (lb[g]||[]).sort(function(a,b){return b.score-a.score;}).slice(0,5);
    if (!entries.length) return;
    anyScores = true;
    out += '<div class="leaderboard-game">'
      + '<div class="leaderboard-game-title">' + gN[g] + '</div>';
    entries.forEach(function(e, i) {
      var medal = i<3 ? medals[i] : (i+1)+'.';
      var isMe = myName && e.name===myName;
      var highlightClass = isMe ? 'highlight' : '';
      out += '<div class="leaderboard-entry '+highlightClass+'>'
           + '<span class="leaderboard-rank">' + medal + '</span>'
           + '<span class="leaderboard-name">' + e.name + '</span>'
           + '<span class="leaderboard-score">' + e.score.toLocaleString() + '</span>'
           + '</div>';
    });
    out += '</div>';
  });
  el.innerHTML = anyScores
    ? out
    : '<div style="padding:20px 16px;text-align:center;color:rgba(255,255,255,0.35);font-size:13px;">No scores yet — play a game!</div>';
}

function renderHighScores() {
  try {
    var pt=document.getElementById('lbPlayerTag');
    var pn=localStorage.getItem('bePlayerName')||"";
    if(pt) {
      pt.innerHTML = pn
        ? 'Playing as <strong>'+pn+'</strong> &bull; <a href="#" onclick="localStorage.removeItem(\'bePlayerName\');renderHighScores();loadLeaderboard();return false;">Change</a>'
        : '<a href="#" onclick="promptNameLB(\'wirewizard\',0);return false;">Set your name</a>';
    }
  } catch(e) {}
  var el=document.getElementById('gameHighScores');if(!el)return;
  var labels={wirewizard:'Wire Wizard',hazardquiz:'Hazard Quiz'};
  var hasAny=Object.keys(labels).some(function(k){return HIGH_SCORES[k];});
  if(!hasAny){el.innerHTML='';return;}
  el.innerHTML=''
    +Object.keys(labels).filter(function(k){return HIGH_SCORES[k];}).map(function(k){
      return '<div class="score-item"><span class="score-item-name">'+labels[k]+'</span><span class="score-item-value">'+HIGH_SCORES[k].toLocaleString()+'</span></div>';
    }).join('');
}

// ═══════════════════════════════════════
// GAME CONTROL
// ═══════════════════════════════════════

function startGame(gameId) {
  currentGame = gameId;
  const overlay = document.getElementById('gameOverlay');
  const container = document.getElementById('gameContainer');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (gameId === 'wirewizard') startWireWizard(container);
  else if (gameId === 'hazardquiz') startHazardQuiz(container);
}

function closeGame() {
  if (gameAnimFrame) { cancelAnimationFrame(gameAnimFrame); gameAnimFrame = null; }
  document.getElementById('gameOverlay').classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('gameContainer').innerHTML = '';
  document.getElementById('gameScoreDisplay').textContent = '';
  currentGame = null;
  renderHighScores();
  loadLeaderboard();
}

// ═══════════════════════════════════════
// WIRE WIZARD GAME
// ═══════════════════════════════════════

function startWireWizard(container) {
  document.getElementById('gameTitle').textContent = 'Wire Wizard';
  requestAnimationFrame(function() { _initWW(container); });
}

function _initWW(container) {
  var hiScore = HIGH_SCORES.wirewizard || 0;

  var WIRE_COLORS = [
    {stroke:'#FFD700',glow:'#FFB800',dark:'#7a5c00',label:'A'},
    {stroke:'#00E5FF',glow:'#00B8D4',dark:'#004f5e',label:'B'},
    {stroke:'#76FF03',glow:'#4CAF50',dark:'#1a4a00',label:'C'},
    {stroke:'#FF4081',glow:'#F50057',dark:'#7a001f',label:'D'},
    {stroke:'#E040FB',glow:'#AA00FF',dark:'#4a0070',label:'E'},
    {stroke:'#FF6D00',glow:'#FF3D00',dark:'#7a2800',label:'F'},
  ];

  // Pre-generated guaranteed-solvable levels
  var LEVELS = [{"cols":5,"rows":6,"pairs":[{"a":[4,4],"b":[4,5],"ci":0},{"a":[4,2],"b":[4,3],"ci":1}],"solution":[[[4,4],[3,4],[3,5],[2,5],[2,4],[1,4],[1,5],[0,5],[0,4],[0,3],[0,2],[0,1],[0,0],[1,0],[1,1],[1,2],[2,2],[2,3],[1,3],[4,5]],[[4,2],[4,1],[4,0],[3,0],[2,0],[2,1],[3,1],[3,2],[3,3],[4,3]]]},{"cols":5,"rows":7,"pairs":[{"a":[1,0],"b":[3,2],"ci":0},{"a":[3,4],"b":[0,6],"ci":1},{"a":[4,4],"b":[3,6],"ci":2}],"solution":[[[1,0],[0,0],[0,1],[1,1],[2,1],[3,1],[4,1],[4,2],[4,3],[3,3],[2,3],[1,3],[0,3],[0,4],[0,5],[2,0],[3,0],[4,0],[0,2],[1,2],[2,2],[3,2]],[[3,4],[3,5],[2,5],[2,6],[1,6],[1,5],[1,4],[2,4],[0,6]],[[4,4],[4,5],[4,6],[3,6]]]},{"cols":6,"rows":7,"pairs":[{"a":[2,2],"b":[3,6],"ci":0},{"a":[5,2],"b":[3,3],"ci":1},{"a":[0,1],"b":[0,0],"ci":2}],"solution":[[[2,2],[2,3],[1,3],[0,3],[0,4],[0,5],[1,5],[1,4],[2,4],[2,5],[3,5],[4,5],[4,6],[5,6],[5,5],[5,4],[5,3],[4,3],[3,4],[4,4],[0,6],[1,6],[2,6],[3,6]],[[5,2],[4,2],[3,2],[3,1],[2,1],[1,1],[1,0],[2,0],[3,0],[4,0],[5,0],[5,1],[4,1],[3,3]],[[0,1],[0,2],[1,2],[0,0]]]},{"cols":6,"rows":8,"pairs":[{"a":[2,0],"b":[2,4],"ci":0},{"a":[3,2],"b":[5,2],"ci":1},{"a":[5,5],"b":[1,4],"ci":2},{"a":[2,7],"b":[4,4],"ci":3}],"solution":[[[2,0],[2,1],[2,2],[1,2],[0,2],[0,1],[1,1],[1,0],[0,0],[2,3],[2,4]],[[3,2],[4,2],[4,1],[4,0],[3,0],[3,1],[5,0],[5,1],[5,2]],[[5,5],[5,4],[5,3],[4,3],[3,3],[3,4],[3,5],[2,5],[1,5],[1,6],[1,7],[0,7],[0,6],[0,5],[0,4],[0,3],[1,3],[1,4]],[[2,7],[2,6],[3,6],[3,7],[4,7],[5,7],[5,6],[4,6],[4,5],[4,4]]]},{"cols":7,"rows":8,"pairs":[{"a":[4,2],"b":[6,1],"ci":0},{"a":[6,4],"b":[6,2],"ci":1},{"a":[0,2],"b":[0,1],"ci":2},{"a":[3,7],"b":[3,6],"ci":3}],"solution":[[[4,2],[4,1],[3,1],[3,2],[3,3],[3,4],[3,5],[4,5],[5,5],[6,5],[6,6],[6,7],[5,7],[4,7],[4,6],[5,6],[4,0],[5,0],[6,0],[5,1],[6,1]],[[6,4],[6,3],[5,3],[5,4],[4,4],[4,3],[5,2],[6,2]],[[0,2],[0,3],[0,4],[1,4],[1,5],[2,5],[2,4],[2,3],[2,2],[2,1],[2,0],[1,0],[1,1],[1,2],[1,3],[0,0],[3,0],[0,1]],[[3,7],[2,7],[2,6],[1,6],[1,7],[0,7],[0,6],[0,5],[3,6]]]},{"cols":7,"rows":9,"pairs":[{"a":[6,2],"b":[6,5],"ci":0},{"a":[2,5],"b":[1,1],"ci":1},{"a":[5,8],"b":[4,8],"ci":2},{"a":[1,2],"b":[5,6],"ci":3},{"a":[6,6],"b":[6,8],"ci":4}],"solution":[[[6,2],[5,2],[5,1],[4,1],[4,0],[5,0],[6,0],[6,1],[5,3],[6,3],[5,4],[6,4],[6,5]],[[2,5],[3,5],[3,4],[3,3],[2,3],[1,3],[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[3,1],[2,1],[1,1]],[[5,8],[5,7],[4,7],[3,7],[2,7],[1,7],[0,7],[0,8],[1,8],[2,8],[3,8],[4,8]],[[1,2],[2,2],[3,2],[4,2],[4,3],[4,4],[4,5],[4,6],[3,6],[2,6],[1,6],[0,6],[0,5],[0,4],[1,4],[2,4],[1,5],[5,5],[5,6]],[[6,6],[6,7],[6,8]]]},{"cols":7,"rows":9,"pairs":[{"a":[0,1],"b":[2,6],"ci":0},{"a":[2,3],"b":[5,8],"ci":1},{"a":[2,0],"b":[4,5],"ci":2},{"a":[1,3],"b":[2,5],"ci":3},{"a":[0,8],"b":[0,6],"ci":4}],"solution":[[[0,1],[0,0],[1,0],[1,1],[1,2],[0,2],[0,3],[0,4],[0,5],[1,5],[1,6],[1,7],[1,8],[2,8],[2,7],[2,6]],[[2,3],[2,2],[2,1],[3,1],[3,2],[3,3],[3,4],[3,5],[3,6],[3,7],[4,7],[4,6],[5,6],[6,6],[6,7],[6,8],[5,7],[3,8],[4,8],[5,8]],[[2,0],[3,0],[4,0],[4,1],[5,1],[5,2],[4,2],[4,3],[5,3],[5,4],[5,5],[6,5],[6,4],[6,3],[6,2],[6,1],[5,0],[6,0],[4,4],[4,5]],[[1,3],[1,4],[2,4],[2,5]],[[0,8],[0,7],[0,6]]]},{"cols":7,"rows":10,"pairs":[{"a":[0,8],"b":[2,9],"ci":0},{"a":[6,7],"b":[6,9],"ci":1},{"a":[6,4],"b":[3,5],"ci":2},{"a":[1,2],"b":[0,0],"ci":3},{"a":[4,2],"b":[4,3],"ci":4},{"a":[4,1],"b":[6,0],"ci":5}],"solution":[[[0,8],[0,9],[1,9],[1,8],[2,8],[2,7],[1,7],[1,6],[1,5],[0,5],[0,4],[1,4],[2,4],[3,4],[4,4],[0,6],[0,7],[2,9]],[[6,7],[6,6],[5,6],[5,7],[5,8],[5,9],[4,9],[3,9],[3,8],[3,7],[4,7],[4,8],[6,8],[6,9]],[[6,4],[6,5],[5,5],[4,5],[4,6],[3,6],[2,6],[2,5],[3,5]],[[1,2],[1,1],[1,0],[2,0],[3,0],[3,1],[2,1],[2,2],[3,2],[3,3],[2,3],[1,3],[0,3],[0,2],[0,1],[0,0]],[[4,2],[5,2],[5,3],[5,4],[4,3]],[[4,1],[4,0],[5,0],[5,1],[6,1],[6,2],[6,3],[6,0]]]}];

  var W = container.clientWidth || window.innerWidth;
  var H = container.clientHeight || (window.innerHeight - 60);
  if (H < 300) H = window.innerHeight - 60;

  var levelIdx = 0, score = 0;
  var paths, dragging, solved, particles, frame, animReq;
  var COLS, ROWS, CELL, GW, GH;

  // ---- Setup canvas and HUD once ----
  container.innerHTML = '';

  var hud = document.createElement('div');
  hud.style.cssText = 'flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:8px 16px 6px;background:rgba(0,0,0,0.55);';
  hud.innerHTML = '<div id="wwLevel" style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.8);letter-spacing:0.5px;">LEVEL 1</div>'
    + '<div style="font-size:11px;color:rgba(255,255,255,0.35);">Route all wires • fill every cell</div>'
    + '<div id="wwScore" style="font-size:13px;font-weight:700;color:#FFD700;">0 pts</div>';
  container.appendChild(hud);

  var cvWrap = document.createElement('div');
  cvWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;';
  container.appendChild(cvWrap);

  var cv = document.createElement('canvas');
  cv.style.cssText = 'display:block;touch-action:none;cursor:crosshair;';
  cvWrap.appendChild(cv);
  var ctx = cv.getContext('2d');

  var tip = document.createElement('div');
  tip.style.cssText = 'flex-shrink:0;text-align:center;padding:5px 16px 8px;font-size:11px;color:rgba(255,255,255,0.28);';
  tip.innerHTML = 'Drag from node to route • backtrack to erase • <span id="wwResetBtn" style="color:#FFD700;cursor:pointer;text-decoration:underline;">reset level</span>';
  container.appendChild(tip);

  function sizeCanvas() {
    var lv = LEVELS[levelIdx];
    COLS = lv.cols; ROWS = lv.rows;
    var maxCW = container.clientWidth || W;
    var maxCH = (cvWrap.clientHeight || H - 100);
    CELL = Math.min(Math.floor(maxCW / COLS), Math.floor(maxCH / ROWS));
    if (CELL < 32) CELL = 32;
    if (CELL > 62) CELL = 62;
    GW = COLS * CELL; GH = ROWS * CELL;
    cv.width = GW; cv.height = GH;
  }

  function initLevel(idx) {
    levelIdx = idx;
    sizeCanvas();
    solved = false; dragging = null; particles = []; frame = 0;
    var lv = LEVELS[idx];
    paths = lv.pairs.map(function(p) {
      return {
        a: {c:p.a[0], r:p.a[1]},
        b: {c:p.b[0], r:p.b[1]},
        color: WIRE_COLORS[p.ci],
        solution: lv.solution[p.ci],
        cells: [],
        complete: false
      };
    });
    document.getElementById('wwLevel').textContent = 'LEVEL ' + (idx+1);
    document.getElementById('gameScoreDisplay').textContent = '';
  }

  // ---- Grid helpers ----
  function cellAt(px, py) {
    var c = Math.floor(px / CELL), r = Math.floor(py / CELL);
    if (c<0||c>=COLS||r<0||r>=ROWS) return null;
    return {c:c,r:r};
  }
  function cellEq(a,b) { return a&&b&&a.c===b.c&&a.r===b.r; }
  function ctr(c,r) { return {x:c*CELL+CELL/2, y:r*CELL+CELL/2}; }
  function isEndpoint(p,c,r) { return cellEq(p.a,{c:c,r:r})||cellEq(p.b,{c:c,r:r}); }
  function occupiedBy(c,r,exclude) {
    for (var i=0;i<paths.length;i++) {
      var p=paths[i]; if(p===exclude) continue;
      if(isEndpoint(p,c,r)) return p;
      for(var j=0;j<p.cells.length;j++) if(cellEq(p.cells[j],{c:c,r:r})) return p;
    }
    return null;
  }

  // ---- Drawing ----
  function draw() {
    frame++;
    ctx.clearRect(0,0,GW,GH);

    // PCB background
    var bg=ctx.createLinearGradient(0,0,GW,GH);
    bg.addColorStop(0,'#060e1e'); bg.addColorStop(1,'#0a1628');
    ctx.fillStyle=bg; ctx.fillRect(0,0,GW,GH);

    // Grid
    ctx.strokeStyle='rgba(0,200,255,0.06)'; ctx.lineWidth=0.5;
    for(var c=0;c<=COLS;c++){ctx.beginPath();ctx.moveTo(c*CELL,0);ctx.lineTo(c*CELL,GH);ctx.stroke();}
    for(var r=0;r<=ROWS;r++){ctx.beginPath();ctx.moveTo(0,r*CELL);ctx.lineTo(GW,r*CELL);ctx.stroke();}

    // Cell dots
    ctx.fillStyle='rgba(0,180,255,0.08)';
    for(var c=0;c<=COLS;c++) for(var r=0;r<=ROWS;r++){ctx.beginPath();ctx.arc(c*CELL,r*CELL,1.2,0,Math.PI*2);ctx.fill();}

    // Coverage indicator - filled cells glow subtly
    paths.forEach(function(p) {
      if (!p.cells.length) return;
      p.cells.forEach(function(cell) {
        var cx=cell.c*CELL, cy=cell.r*CELL;
        ctx.fillStyle = p.color.stroke + '18';
        ctx.fillRect(cx+1, cy+1, CELL-2, CELL-2);
      });
    });

    // Drawn paths (wire segments)
    paths.forEach(function(p) {
      if (p.cells.length < 2) return;
      var col=p.color;
      ctx.save();
      ctx.lineCap='round'; ctx.lineJoin='round';
      // Glow
      ctx.shadowColor=col.glow; ctx.shadowBlur=16;
      ctx.strokeStyle=col.stroke; ctx.lineWidth=CELL*0.36; ctx.globalAlpha=0.22;
      drawWirePath(ctx, p.cells);
      // Main
      ctx.globalAlpha=1; ctx.shadowBlur=8;
      ctx.lineWidth=CELL*0.28;
      drawWirePath(ctx, p.cells);
      // Highlight
      ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.lineWidth=CELL*0.08; ctx.shadowBlur=0;
      drawWirePath(ctx, p.cells);
      ctx.restore();
    });

    // Nodes (endpoints)
    paths.forEach(function(p) {
      drawNode(p, p.a);
      drawNode(p, p.b);
    });

    // Particles
    particles = particles.filter(function(p) {
      p.x+=p.vx; p.y+=p.vy; p.vy+=0.08; p.life-=0.04; p.r*=0.96;
      if(p.life<=0) return false;
      ctx.save(); ctx.globalAlpha=p.life;
      ctx.fillStyle=p.color; ctx.shadowColor=p.color; ctx.shadowBlur=6;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
      ctx.restore(); return true;
    });

    // Solved flash
    if (solved) {
      var t = Math.min(1, (frame-solvedFrame)/50);
      ctx.fillStyle='rgba(0,255,160,'+(0.08*t)+')';
      ctx.fillRect(0,0,GW,GH);
    }

    animReq = requestAnimationFrame(draw);
  }

  function drawWirePath(ctx, cells) {
    ctx.beginPath();
    var pt = ctr(cells[0].c, cells[0].r);
    ctx.moveTo(pt.x, pt.y);
    for (var i=1;i<cells.length;i++) {
      pt = ctr(cells[i].c, cells[i].r);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }

  function drawNode(p, node) {
    var ct = ctr(node.c, node.r);
    var r = CELL*0.34;
    ctx.save();
    ctx.shadowColor=p.color.glow; ctx.shadowBlur=p.complete?22:14;
    ctx.beginPath(); ctx.arc(ct.x, ct.y, r, 0, Math.PI*2);
    ctx.fillStyle = p.complete ? p.color.stroke : p.color.dark;
    ctx.fill();
    ctx.strokeStyle=p.color.stroke; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.arc(ct.x, ct.y, r, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = p.complete ? p.color.dark : p.color.stroke;
    ctx.font = 'bold '+Math.round(CELL*0.28)+'px -apple-system,sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.shadowBlur=0;
    ctx.fillText(p.color.label, ct.x, ct.y+0.5);
    ctx.restore();
  }

  function burst(x,y,color,n) {
    for(var i=0;i<n;i++){
      var a=Math.random()*Math.PI*2, sp=1.5+Math.random()*3;
      particles.push({x:x,y:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-0.5,life:1,color:color,r:2+Math.random()*3});
    }
  }

  // ---- Win check ----
  var solvedFrame = 0;
  function checkWin() {
    if (!paths.every(function(p){return p.complete;})) return false;
    var used = new Set();
    paths.forEach(function(p){p.cells.forEach(function(c){used.add(c.c+','+c.r);});});
    return used.size === COLS*ROWS;
  }

  function onLevelSolved() {
    solved = true; solvedFrame = frame;
    var pts = 300 + levelIdx*100 + paths.length*50;
    score += pts;
    document.getElementById('wwScore').textContent = score + ' pts';
    paths.forEach(function(p){
      var ca=ctr(p.a.c,p.a.r), cb=ctr(p.b.c,p.b.r);
      burst(ca.x,ca.y,p.color.stroke,16);
      burst(cb.x,cb.y,p.color.stroke,16);
    });
    saveHighScore('wirewizard', score);
    setTimeout(function(){
      if (levelIdx < LEVELS.length-1) { initLevel(levelIdx+1); }
      else { showComplete(); }
    }, 1600);
  }

  function showComplete() {
    if(animReq) cancelAnimationFrame(animReq);
    var hi=HIGH_SCORES.wirewizard, isNew=score>=hi&&score>0;
    var ov=document.createElement('div');
    ov.style.cssText='position:absolute;inset:0;background:rgba(5,12,32,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px;';
    ov.innerHTML='<div style="font-size:52px;">⚡</div>'
      +'<div style="font-size:22px;font-weight:800;color:#fff;">All Circuits Wired!</div>'
      +'<div style="font-size:40px;font-weight:800;color:#FFD700;">'+score+'</div>'
      +'<div style="font-size:13px;color:rgba(255,255,255,0.45);">'+(isNew?'🏆 New High Score!':'Best: '+hi)+'</div>'
      +'<button onclick="startWireWizard(document.getElementById(\'gameContainer\'))" '
      +'style="background:rgba(255,200,0,0.2);border:1.5px solid rgba(255,200,0,0.5);border-radius:14px;padding:13px 34px;color:#FFD700;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;">Play Again</button>';
    cvWrap.appendChild(ov);
  }

  // ---- Input ----
  function getPos(e) {
    var rect=cv.getBoundingClientRect();
    var src=e.touches?e.touches[0]:e;
    return {x:(src.clientX-rect.left)*(GW/rect.width), y:(src.clientY-rect.top)*(GH/rect.height)};
  }

  function onStart(e) {
    if(solved) return;
    var pos=getPos(e), cell=cellAt(pos.x,pos.y); if(!cell) return;
    // Find the path this endpoint belongs to
    var found=null;
    paths.forEach(function(p){ if(isEndpoint(p,cell.c,cell.r)) found=p; });
    if(!found) return;
    // Clear this path
    found.cells=[{c:cell.c,r:cell.r}]; found.complete=false;
    dragging=found;
  }

  function onMove(e) {
    if(!dragging) return;
    var pos=getPos(e), cell=cellAt(pos.x,pos.y); if(!cell) return;
    var dc=dragging.cells, last=dc[dc.length-1];
    if(cellEq(last,cell)) return;
    // Adjacency check
    if(Math.abs(cell.c-last.c)+Math.abs(cell.r-last.r)!==1) return;
    // Backtrack
    if(dc.length>=2&&cellEq(dc[dc.length-2],cell)){dc.pop();return;}
    // Occupied by another path?
    if(occupiedBy(cell.c,cell.r,dragging)) return;
    // Loop prevention
    for(var i=0;i<dc.length-1;i++){
      if(cellEq(dc[i],cell)){dragging.cells=dc.slice(0,i+1);return;}
    }
    dragging.cells.push({c:cell.c,r:cell.r});
    // Reached other endpoint?
    if(isEndpoint(dragging,cell.c,cell.r)&&!cellEq(cell,dragging.cells[0])){
      dragging.complete=true;
      var ct2=ctr(cell.c,cell.r);
      burst(ct2.x,ct2.y,dragging.color.stroke,14);
      dragging=null;
      if(checkWin()) onLevelSolved();
    }
  }

  function onEnd() { dragging=null; }

  cv.addEventListener('mousedown',function(e){e.preventDefault();onStart(e);});
  cv.addEventListener('mousemove',function(e){if(dragging){e.preventDefault();onMove(e);}});
  cv.addEventListener('mouseup',onEnd);
  cv.addEventListener('mouseleave',onEnd);
  cv.addEventListener('touchstart',function(e){e.preventDefault();onStart(e);},{passive:false});
  cv.addEventListener('touchmove',function(e){e.preventDefault();onMove(e);},{passive:false});
  cv.addEventListener('touchend',function(e){e.preventDefault();onEnd();},{passive:false});

  // Reset button
  setTimeout(function(){
    var rb=document.getElementById('wwResetBtn');
    if(rb) rb.addEventListener('click',function(){initLevel(levelIdx);});
  },100);

  // Close hook
  var origClose=window.closeGame;
  window.closeGame=function(){
    if(animReq) cancelAnimationFrame(animReq);
    if(origClose) origClose();
    window.closeGame=origClose;
  };

  initLevel(0);
  draw();
}

// ═══════════════════════════════════════
// HAZARD QUIZ GAME
// ═══════════════════════════════════════

function startHazardQuiz(container) {
  document.getElementById('gameTitle').textContent = 'Hazard Quiz';

  const ALL_QUESTIONS = [
    // --- ELECTRICAL SAFETY ---
    {q:"What's the minimum fall protection height in construction?",a:"6 feet",w:["4 feet","10 feet","8 feet"]},
    {q:"What does GFCI stand for?",a:"Ground Fault Circuit Interrupter",w:["General Fuse Current Indicator","Ground Frequency Circuit Isolator","Grounded Fixture Control Interface"]},
    {q:"What color is a safety ground wire in US residential wiring?",a:"Green or bare copper",w:["White","Black","Red"]},
    {q:"Before working on energized equipment you should always:",a:"Test the circuit with a meter",w:["Wear gloves only","Assume it's off","Work quickly"]},
    {q:"What does LOTO stand for?",a:"Lockout/Tagout",w:["Leverage Output Transfer Operation","Load Output Test Only","Line Off Transfer Order"]},
    {q:"Which PPE protects against arc flash?",a:"Arc-rated flame resistant clothing",w:["Standard cotton clothing","Leather gloves","Hard hat only"]},
    {q:"What is the safe approach boundary for unqualified workers near 480V?",a:"Restricted approach boundary with permit",w:["3 feet minimum","10 feet minimum","No restriction needed"]},
    {q:"What voltage is considered 'low voltage' in the US?",a:"600V or less",w:["120V or less","240V or less","1000V or less"]},
    {q:"What does an arc flash hazard label show?",a:"Incident energy level and PPE requirements",w:["Voltage only","Wire gauge","Circuit breaker rating"]},
    {q:"The 'one-hand rule' in electrical work means:",a:"Keep one hand in your pocket to avoid current path through your heart",w:["Only use one hand for tools","Always hold ground with one hand","Use one hand to flip breakers"]},
    {q:"What is the primary cause of electrical fires?",a:"Overloaded circuits and faulty wiring",w:["Wet conditions","Lack of PPE","Improper labeling"]},
    {q:"What class of fire extinguisher is used on electrical fires?",a:"Class C",w:["Class A","Class B","Class D"]},
    {q:"What is the minimum insulation resistance for electrical equipment?",a:"1 megohm per 1000V",w:["100 ohms","10 kiloohms","500 kiloohms"]},
    {q:"CPR stands for:",a:"Cardiopulmonary Resuscitation",w:["Critical Patient Response","Cardiac Pressure Rotation","Cardio Pulse Restoration"]},
    {q:"How many volts AC can cause ventricular fibrillation?",a:"As low as 50-100 mA current, not voltage alone",w:["Always 1000V+","Exactly 120V","Only high voltage DC"]},
    // --- PPE & SAFETY GEAR ---
    {q:"What PPE should always be worn when working overhead?",a:"Hard hat",w:["Face shield only","Hearing protection","Knee pads"]},
    {q:"Safety glasses should be rated to which standard?",a:"ANSI Z87.1",w:["OSHA 1910.133","NFPA 70E","ASTM F150"]},
    {q:"Class E hard hats protect against:",a:"Electrical hazards up to 20,000V",w:["Impact only","Chemical splash","Noise exposure"]},
    {q:"When should safety gloves be inspected?",a:"Before each use",w:["Monthly","Annually","Only after incidents"]},
    {q:"What does an OSHA 300 log record?",a:"Work-related injuries and illnesses",w:["Equipment maintenance","Chemical inventory","Safety training hours"]},
    {q:"Hi-visibility clothing is required when:",a:"Working near moving vehicles or heavy equipment",w:["Always outdoors","Only at night","When using power tools"]},
    {q:"Safety harnesses must be inspected:",a:"Before each use and annually by a competent person",w:["Weekly","Only after a fall event","Quarterly"]},
    {q:"Steel-toed boots protect against:",a:"Falling objects and compression",w:["Electrical shock","Slips and falls","Chemical exposure"]},
    {q:"Hearing protection is required when noise levels exceed:",a:"85 dB over an 8-hour TWA",w:["70 dB","100 dB","65 dB"]},
    {q:"A dust mask (N95) filters particles down to:",a:"0.3 microns at 95% efficiency",w:["1 micron at 99%","10 microns at 95%","0.1 microns at 90%"]},
    // --- OSHA & REGULATIONS ---
    {q:"How long do employers have to report an inpatient hospitalization to OSHA?",a:"24 hours",w:["8 hours","72 hours","1 week"]},
    {q:"A fatality must be reported to OSHA within:",a:"8 hours",w:["24 hours","48 hours","1 week"]},
    {q:"The OSHA General Duty Clause requires employers to:",a:"Provide a workplace free from recognized hazards",w:["Post all OSHA notices","Train workers monthly","Conduct daily inspections"]},
    {q:"How long must OSHA 300A summaries be posted?",a:"February 1 through April 30",w:["January 1 through December 31","Year-round","Only in December"]},
    {q:"What does SDS stand for?",a:"Safety Data Sheet",w:["Standard Data Summary","Safety Directive Sheet","Standard Documentation System"]},
    {q:"How many sections are in a GHS-compliant SDS?",a:"16",w:["8","12","20"]},
    {q:"Right-to-know laws require employers to:",a:"Inform employees about hazardous chemicals in the workplace",w:["Post wages publicly","Provide daily safety briefings","Log all near-misses"]},
    {q:"OSHA's HazCom standard is also known as:",a:"Hazard Communication or Right-to-Know",w:["Chemical Safety Rule","Worker Protection Act","Toxic Substance Law"]},
    {q:"What does the GHS pictogram with a skull and crossbones indicate?",a:"Acute toxicity (fatal or toxic)",w:["Corrosive material","Environmental hazard","Flammable substance"]},
    {q:"NFPA 70E covers:",a:"Electrical safety in the workplace",w:["Fire prevention","Chemical handling","Fall protection"]},
    // --- HAZARD IDENTIFICATION ---
    {q:"What does a yellow diamond GHS label signal word indicate?",a:"Warning (moderate hazard)",w:["Danger (severe hazard)","Caution (minor hazard)","Safe to use"]},
    {q:"What color are caution signs per OSHA standards?",a:"Yellow with black lettering",w:["Orange with black lettering","Green with white lettering","Red with white lettering"]},
    {q:"A 'Danger' sign indicates:",a:"Immediate hazard which will cause death or serious injury",w:["Possible hazard that may cause injury","General safety information","Equipment caution only"]},
    {q:"The NFPA 704 diamond system uses how many categories?",a:"4 (Health, Flammability, Instability, Special)",w:["3","5","6"]},
    {q:"In the NFPA 704 system, what does a rating of 4 mean?",a:"Most severe/dangerous",w:["Least severe","Moderate hazard","No hazard"]},
    {q:"What does a white W with a line through it mean on an NFPA label?",a:"Do not use water",w:["Water reactive","Waterproof","Water required for safety"]},
    {q:"GHS pictogram with a flame indicates:",a:"Flammable material",w:["Oxidizer","Explosive","Corrosive"]},
    {q:"A confined space is defined as having:",a:"Limited entry/exit and not designed for continuous occupancy",w:["Any space under 100 sq ft","Areas with low ceilings","Spaces without windows"]},
    {q:"What makes a confined space 'permit-required'?",a:"Presence of a serious safety or health hazard",w:["Being underground","Having no natural light","Being over 4 feet deep"]},
    {q:"A hot work permit is required for:",a:"Welding, cutting, or grinding near combustibles",w:["Working in high temperatures","Electrical work on live circuits","Any outdoor work in summer"]},
    // --- CHEMICAL SAFETY ---
    {q:"What should you do immediately if a chemical splashes in your eyes?",a:"Flush with water for 15-20 minutes",w:["Apply eye drops","Cover with a bandage","Rub gently with a cloth"]},
    {q:"What does LEL stand for?",a:"Lower Explosive Limit",w:["Lethal Exposure Level","Legal Emission Limit","Low Energy Level"]},
    {q:"Personal exposure to chemicals should be compared to:",a:"OSHA PEL or ACGIH TLV",w:["The SDS flash point","The boiling point","The NFPA rating"]},
    {q:"A flammable liquid has a flash point of:",a:"Below 100°F (37.8°C)",w:["Above 200°F","Between 100-200°F","Over 300°F"]},
    {q:"Secondary containers for chemicals must be labeled with:",a:"Product name and hazard information",w:["Manufacturer name only","Purchase date","Employee name"]},
    {q:"Chemical waste must be disposed of:",a:"Per EPA and local regulations",w:["In the regular trash","Down the drain if diluted","Buried on-site"]},
    {q:"A corrosive chemical can:",a:"Destroy skin or metals on contact",w:["Only damage plastics","Only affect lungs","Cause hearing loss"]},
    {q:"Incompatible chemicals should be stored:",a:"Separately to prevent dangerous reactions",w:["Together for easier access","Alphabetically","By purchase date"]},
    {q:"What does SDS Section 8 cover?",a:"Exposure controls and personal protection",w:["First aid measures","Physical properties","Regulatory information"]},
    {q:"Safety showers should be tested:",a:"Weekly and flow tested annually",w:["Daily","Monthly","Only after use"]},
    // --- TOOL SAFETY ---
    {q:"Electrical tools should be inspected before use for:",a:"Damaged cords, missing guards, and proper function",w:["Brand and model","Color coding","Weight and size"]},
    {q:"Double-insulated tools do NOT require:",a:"A grounding conductor (three-prong plug)",w:["A safety guard","Operator training","Regular inspection"]},
    {q:"When should a power tool be unplugged?",a:"Before adjusting, cleaning, or changing accessories",w:["Only when fully broken","After each work day","Every 2 hours of use"]},
    {q:"Extension cords should be rated for:",a:"At least the same wattage as the equipment used",w:["Any load","Double the intended load","Half the intended load"]},
    {q:"The correct way to pass a sharp tool to another worker is:",a:"Handle-first with blade/tip pointed away",w:["Blade-first for easier grip","Throw gently","Set it down and let them pick it up"]},
    {q:"Ladder safety: the correct angle is:",a:"4:1 ratio (1 foot out for every 4 feet up)",w:["3:1 ratio","5:1 ratio","2:1 ratio"]},
    {q:"A damaged ladder should be:",a:"Tagged out of service and repaired or replaced",w:["Repaired quickly with tape","Used for light tasks only","Stored until needed"]},
    {q:"Angle grinders require which PPE?",a:"Face shield, gloves, and hearing protection",w:["Safety glasses only","Hard hat and vest","Gloves only"]},
    {q:"Power tools should never be:",a:"Used in wet conditions without GFCI protection",w:["Used on metal","Used outdoors","Stored in a toolbox"]},
    {q:"When using a circular saw, you should:",a:"Let the blade stop completely before setting it down",w:["Hold the material with your free hand","Keep your finger on the trigger","Always cut toward yourself"]},
    // --- FIRE SAFETY ---
    {q:"PASS stands for:",a:"Pull, Aim, Squeeze, Sweep",w:["Push, Aim, Spray, Stop","Pull, Activate, Spray, Sweep","Prepare, Aim, Squeeze, Spray"]},
    {q:"What class of fire involves flammable liquids?",a:"Class B",w:["Class A","Class C","Class D"]},
    {q:"Fire extinguishers should be inspected:",a:"Monthly and annually by a certified person",w:["Only annually","Daily","Every 5 years"]},
    {q:"The rule for when to fight a fire yourself is:",a:"Only if the fire is small, you have a clear exit, and proper extinguisher",w:["Always try first","Never fight a fire","Only with 2+ people present"]},
    {q:"Hot surfaces should be marked with:",a:"Caution/Warning signs and temperature ratings",w:["Red paint only","Blue tape","No marking needed"]},
    {q:"What should you do if your clothes catch fire?",a:"Stop, Drop, and Roll",w:["Run to water","Remove clothing immediately","Fan the flames out"]},
    {q:"A fire watch is required after hot work for:",a:"At least 30 minutes (or longer per permit)",w:["5 minutes","1 hour minimum","Only if fire occurs"]},
    {q:"Class A fires involve:",a:"Ordinary combustibles (wood, paper, cloth)",w:["Flammable liquids","Electrical equipment","Metal fires"]},
    {q:"The minimum clearance around electrical panels is:",a:"3 feet",w:["1 foot","6 inches","2 feet"]},
    {q:"Flammable storage cabinets should be:",a:"Properly labeled and vented per NFPA 30",w:["Locked at all times","Underground only","Made of plastic"]},
    // --- FALL PROTECTION ---
    {q:"A personal fall arrest system must stop a fall within:",a:"3.5 feet and limit forces to 1800 lbs",w:["6 feet at any force","2 feet at 500 lbs","10 feet at 2000 lbs"]},
    {q:"Self-retracting lifelines must be inspected:",a:"Before each use and annually by a qualified person",w:["Only after a fall","Monthly","Every 5 years"]},
    {q:"What is a 'walking-working surface'?",a:"Any horizontal or vertical surface designed for employee use",w:["Only stairways","Outdoor surfaces only","Just floors and roofs"]},
    {q:"Guardrails must be capable of withstanding:",a:"200 lbs of force in any direction",w:["100 lbs","500 lbs","50 lbs"]},
    {q:"When working on a roof with a slope greater than 4:12, you need:",a:"Fall protection such as PFAS, guardrails, or safety nets",w:["Just anti-slip footwear","Nothing extra needed","Only warning lines"]},
    {q:"A safety net must extend beyond the edge of the work area by:",a:"At least 8 feet",w:["2 feet","4 feet","6 feet"]},
    {q:"Leading edge work without conventional fall protection requires:",a:"A written fall protection plan",w:["Only verbal warning to workers","Double harnesses","No special requirements"]},
    {q:"Scaffolding fall protection is required at:",a:"10 feet for supported scaffolds",w:["6 feet","4 feet","Any height"]},
    {q:"What is the maximum freefall distance with a PFAS?",a:"6 feet",w:["10 feet","3 feet","8 feet"]},
    {q:"Floor openings must be protected by:",a:"Covers rated for 2x the load, or guardrails",w:["Warning tape only","Signs only","Nothing if <12 inches"]},
    // --- REPORTING & INCIDENT RESPONSE ---
    {q:"Near-misses should be reported because:",a:"They identify hazards before someone gets hurt",w:["They are legally required","Only if property damage occurs","They count as incidents"]},
    {q:"After an electrical shock, the victim should:",a:"Be evaluated by medical personnel even if they feel fine",w:["Return to work immediately","Only see a doctor if unconscious","Apply ice and rest"]},
    {q:"First aid kits must be:",a:"Adequate for the hazards present and regularly inspected",w:["Standardized nationally","Only for 10+ person crews","Kept locked at all times"]},
    {q:"Incident investigations should focus on:",a:"Root causes to prevent recurrence",w:["Assigning blame","Filing paperwork","Documenting costs"]},
    {q:"Workers have the right to refuse work that is:",a:"Immediately dangerous to life or health (IDLH)",w:["Uncomfortable or messy","Overtime work","Outside normal job duties"]},
    {q:"Reporting a safety violation to OSHA is protected under:",a:"Section 11(c) of the OSH Act",w:["FMLA","NLRA","ADA"]},
    {q:"Which of the following is a leading indicator of safety performance?",a:"Safety training completion rate",w:["Number of lost-time injuries","OSHA recordable rate","Workers compensation costs"]},
    {q:"An SDS must be available to employees:",a:"At all times during the work shift",w:["Only upon written request","During training only","During OSHA inspections"]},
    {q:"When multiple contractors work on a site, who is responsible for safety?",a:"All parties share responsibility; the controlling employer has primary duty",w:["Only the subcontractor","Only the general contractor","The property owner exclusively"]},
    {q:"What is the primary purpose of a Job Hazard Analysis (JHA)?",a:"Identify and control hazards before work begins",w:["Estimate project costs","Assign tasks to workers","Track time and attendance"]},
  ];

  let questions = [...ALL_QUESTIONS].sort(()=>Math.random()-0.5).slice(0,20).map(q=>({...q,choices:[q.a,...q.w].sort(()=>Math.random()-0.5)}));
  let qIndex = 0, score = 0, streak = 0, timeLeft = 15, timerInterval = null;
  let answered = false;

  function renderQ() {
    if (qIndex >= questions.length) { endQuiz(); return; }
    answered = false;
    timeLeft = 15;
    const q = questions[qIndex];
    const shuffled = [...q.choices].sort(()=>Math.random()-0.5);
    container.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;padding:14px 16px;gap:10px;overflow-y:auto;color:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:600;letter-spacing:0.3px;">QUESTION ${qIndex+1} / ${questions.length}</div>
          <div style="display:flex;align-items:center;gap:8px;">
            ${streak>=3?`<div style="background:rgba(255,200,0,0.15);border:0.5px solid rgba(255,200,0,0.35);border-radius:20px;padding:3px 10px;font-size:12px;color:#FFD700;font-weight:700;">🔥 ${streak}x streak</div>`:''}
            <div id="qzTimer" style="background:rgba(255,80,80,0.2);border:0.5px solid rgba(255,80,80,0.4);border-radius:20px;padding:3px 12px;font-size:14px;font-weight:800;color:#FF8080;min-width:32px;text-align:center;">15</div>
          </div>
        </div>
        <div style="background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.14);border-radius:16px;padding:16px 18px;font-size:16px;font-weight:600;color:#fff;line-height:1.5;">${q.q}</div>
        <div id="choices" style="display:flex;flex-direction:column;gap:8px;">
          ${shuffled.map((c,i)=>`
            <button onclick="answerQ(this,'${c.replace(/'/g,"'")}','${q.a.replace(/'/g,"'")}','${q.q.replace(/'/g,"'")}',${qIndex})"
              style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);border-radius:12px;padding:13px 16px;color:#dde2ef;font-size:14px;font-weight:500;cursor:pointer;text-align:left;font-family:inherit;transition:all 0.12s;width:100%;line-height:1.4;">
              <span style="color:rgba(255,255,255,0.38);font-weight:700;margin-right:8px;">${String.fromCharCode(65+i)}.</span>${c}
            </button>`).join('')}
        </div>
        <div id="qzFeedback" style="min-height:40px;"></div>
      </div>`
    timerInterval = setInterval(()=>{
      timeLeft--;
      const el = document.getElementById('qzTimer');
      if (el) { el.textContent = timeLeft; el.style.color = timeLeft<=5?'#ff6b6b':'#fca5a5'; }
      if (timeLeft<=0) { clearInterval(timerInterval); if(!answered) timeUp(); }
    }, 1000);

    document.getElementById('gameScoreDisplay').textContent = `Score: ${score}`;
  }

  window.answerQ = function(btn, chosen, correct, question, qi) {
    if (answered || qi !== qIndex) return;
    answered = true;
    clearInterval(timerInterval);
    const isCorrect = chosen === correct;
    if (isCorrect) { score += 100 + (timeLeft * 10) + (streak >= 3 ? 50 : 0); streak++; }
    else { streak = 0; }
    document.querySelectorAll('#choices button').forEach(b => {
      const raw = b.textContent.trim();
      const txt = raw.replace(/^[A-D]\.\s*/, '');
      if (txt === correct) { b.style.background='rgba(52,199,89,0.2)'; b.style.borderColor='rgba(52,199,89,0.5)'; b.style.color='#80ffaa'; }
      else if (b === btn && !isCorrect) { b.style.background='rgba(255,59,48,0.2)'; b.style.borderColor='rgba(255,59,48,0.5)'; b.style.color='#ff8080'; }
    });
    document.getElementById('qzFeedback').innerHTML = isCorrect
      ? `<div style="color:#80ffaa;font-weight:700;font-size:14px;padding:8px 12px;background:rgba(52,199,89,0.12);border-radius:8px;">✓ Correct! +${100+(timeLeft*10)+(streak>3?50:0)} pts${streak>3?' 🔥':''}</div>`
      : `<div style="color:#ff9090;font-weight:700;font-size:14px;padding:8px 12px;background:rgba(255,59,48,0.12);border-radius:8px;">✗ ${correct}</div>`;
    document.getElementById('gameScoreDisplay').textContent = `Score: ${score}`;
    setTimeout(() => { qIndex++; renderQ(); }, 1600);
  };

  function timeUp() {
    answered = true; streak = 0;
    document.getElementById('qzFeedback').innerHTML = `<div style="color:#FFD700;font-weight:700;font-size:14px;padding:8px 12px;background:rgba(255,200,0,0.1);border-radius:8px;">⏱ Time's up! &mdash; ${questions[qIndex].a}</div>`;
    setTimeout(() => { qIndex++; renderQ(); }, 1600);
  }

  function endQuiz() {
    saveHighScore('hazardquiz', score);
    const isHigh = HIGH_SCORES.hazardquiz >= score;
    const pct = Math.round(score / (questions.length * 250) * 100);
    container.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:14px;text-align:center;color:#fff;">
        <div style="font-size:52px;">${pct>=80?'🏆':pct>=60?'👍':'📖'}</div>
        <div style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.5px;">Quiz Complete!</div>
        <div style="font-size:46px;font-weight:800;color:#FFD700;letter-spacing:-1px;">${score.toLocaleString()}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.45);">${isHigh?'🏆 New High Score!':'Best: '+HIGH_SCORES.hazardquiz.toLocaleString()}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.4);max-width:260px;line-height:1.5;">${pct>=80?'Safety expert! You really know your stuff.':pct>=60?'Good knowledge. Keep studying!':'Review the safety manual and try again!'}</div>
        <button onclick="startHazardQuiz(document.getElementById('gameContainer'))" style="background:rgba(255,200,0,0.2);border:1.5px solid rgba(255,200,0,0.4);border-radius:14px;padding:13px 32px;color:#FFD700;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:6px;">Play Again</button>
      </div>`;
  }

  renderQ();
}
