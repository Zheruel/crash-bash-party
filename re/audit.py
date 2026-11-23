#!/usr/bin/env python3
"""Per-game fidelity audit index built from the Ghidra decompiles.

    python3 re/audit.py <game|all>

For each overlay function (re/out_<game>/ovl.c) and each engine function it calls directly (from all.c), writes
  re/audit/<game>/fn/<addr>.c   one function per file (read these instead of grepping the 60k-line all.c)
  re/audit/<game>/index.md      checklist: size, callers/callees, sound ids, state switches, effect objects, and where our
                                code (web/, re/notes, docs) cites the function
  re/audit/<game>/sfx.md        every literal sound id the overlay plays, with the functions that play it and whether the id
                                appears in our game's code
  re/audit/<game>/status.tsv    one row per function for agents to fill in: addr, status, our file:line, note
                                (status: todo | match | fixed | added | n/a). Existing rows are kept on re-runs.
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RE = ROOT / 're'
GAMES = {  # audit name (= re/out_<dir> unless OVERLAY says otherwise) -> our game id
    'ballistix': 'ballDefence', 'polarPush': 'pushOff', 'pogoPainter': 'tilePainter', 'tankWars': 'tankArena',
    'crateCrush': 'crateToss', 'crashDash': 'dashRace', 'ringDing': 'ringDing', 'dragonDrop': 'dragonDrop',
    'malletMash': 'malletMash', 'kegKaboom': 'kegKaboom', 'podium': 'podium',
}
# The overlay dumps for levels 27/28 were named from the disc's name table, which has the two games the wrong way round:
# re/out_ringDing holds the Dragon Drop overlay and re/out_dragonDrop holds Ring Ding's.
OVERLAY = {'ringDing': 'dragonDrop', 'dragonDrop': 'ringDing'}
HEAD = re.compile(r'^// ==== ([0-9a-f]{8}) (\S+) size=(\d+)', re.M)
FUN = re.compile(r'FUN_([0-9a-f]{8})')
SFX = re.compile(r'FUN_80022660\(\s*([^,()]+)')
STATE = re.compile(r'FUN_800868b4\(\s*[^,()]*,\s*([^,()]+)\)')
FXOBJ = re.compile(r'FUN_80022a3c\(([^;]*?)\);', re.S)
# Engine helpers too generic to audit as behaviour (math, alloc, rng, memcpy...). Still listed as callees.
GENERIC = {'80015590', '8001463c', '800154a0', '80032f3c', '800264e8', '80022660', '800225c4', '80022fd4', '80022a3c',
           '800868b4', '800320ec'}


def split(path: Path) -> dict[str, tuple[str, int, str]]:
    text = path.read_text(errors='replace')
    out = {}
    heads = list(HEAD.finditer(text))
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        out[h.group(1)] = (h.group(2), int(h.group(3)), text[h.start():end])
    return out


def citations() -> dict[str, list[str]]:
    """addr -> ['file:line', ...] for every FUN_<addr> or 0x<addr> mention in our code and notes."""
    cites = defaultdict(list)
    files = [p for d in ('web/client', 'web/shared', 'web/scripts', 'tools') for p in (ROOT / d).rglob('*')
             if p.suffix in ('.ts', '.mjs', '.py') and 'node_modules' not in p.parts]
    pat = re.compile(r'(?:FUN_|0x)([0-9a-fA-F]{8})\b')
    for p in files:
        for n, line in enumerate(p.read_text(errors='replace').splitlines(), 1):
            for m in pat.finditer(line):
                cites[m.group(1).lower()].append(f'{p.relative_to(ROOT)}:{n}')
    return cites


def note_mentions(game: str) -> dict[str, int]:
    out = defaultdict(int)
    for p in [RE / 'notes' / f'{game}.md', RE / 'notes' / 'engine.md']:
        if p.exists():
            for m in re.finditer(r'(?:FUN_|0x)([0-9a-fA-F]{8})\b', p.read_text()):
                out[m.group(1).lower()] += 1
    return out


def num(tok: str) -> int | None:
    tok = tok.strip()
    try:
        return int(tok, 0)
    except ValueError:
        return None


def game_code_ids(gid: str) -> set[int]:
    ids = set()
    for d in ('web/client/games', 'web/shared/games'):
        for p in (ROOT / d).glob(f'{gid}*.ts'):
            for m in re.finditer(r'\b(0x[0-9a-fA-F]+|\d{3,4})\b', p.read_text()):
                t = m.group(1); ids.add(int(t, 16) if t.startswith("0x") else int(t))
    return ids


def audit(game: str, cites):
    gid = GAMES[game]
    src = OVERLAY.get(game, game)
    ovl = split(RE / f'out_{src}' / 'ovl.c')
    full = split(RE / f'out_{src}' / 'all.c')
    out = RE / 'audit' / game
    (out / 'fn').mkdir(parents=True, exist_ok=True)
    notes = note_mentions(game)

    callers = defaultdict(set)
    for a, (_, _, body) in full.items():
        for c in set(FUN.findall(body)):
            if c != a:
                callers[c].add(a)

    engine = defaultdict(int)  # engine fn -> number of overlay call sites
    for a, (_, _, body) in ovl.items():
        for c in FUN.findall(body):
            if c not in ovl and c in full and c not in GENERIC:
                engine[c] += 1

    sfx_use = defaultdict(set)
    rows = []

    def row(a, name, size, body, kind):
        (out / 'fn' / f'{a}.c').write_text(body)
        sfx = [s for s in (num(x) for x in SFX.findall(body)) if s is not None]
        for s in sfx:
            sfx_use[s].add(a)
        states = sorted({x.strip() for x in STATE.findall(body)})
        fx = sorted({args.split(',')[3].strip() for args in FXOBJ.findall(body) if args.count(',') >= 4})
        callees = sorted({c for c in FUN.findall(body) if c != a and c not in GENERIC})
        cited = [c for c in cites.get(a, []) if not c.startswith('tools/')]
        rows.append(dict(a=a, kind=kind, size=size, lines=body.count('\n'), cited=cited, notes=notes.get(a, 0),
                         sfx=sorted(set(sfx)), states=states, fx=fx, callees=callees,
                         callers=sorted(callers.get(a, ()))[:6]))

    for a, (name, size, body) in sorted(ovl.items()):
        row(a, name, size, body, 'ovl')
    for a in sorted(engine):
        name, size, body = full[a]
        row(a, name, size, body, f'eng x{engine[a]}')

    # status.tsv: keep agents' existing rows
    st_path = out / 'status.tsv'
    status = {}
    if st_path.exists():
        for line in st_path.read_text().splitlines()[1:]:
            parts = line.split('\t')
            if parts and parts[0]:
                status[parts[0]] = parts
    with st_path.open('w') as f:
        f.write('addr\tstatus\tours\tnote\n')
        for r in rows:
            prev = status.get(r['a'])
            f.write('\t'.join(prev) + '\n' if prev else f"{r['a']}\ttodo\t\t\n")

    def cell(xs, n=4):
        xs = list(xs)
        return ', '.join(map(str, xs[:n])) + (f' +{len(xs) - n}' if len(xs) > n else '')

    hexs = lambda xs: [hex(x) for x in xs]
    uncited = [r for r in rows if not r['cited']]
    with (out / 'index.md').open('w') as f:
        f.write(f'# {game} ({gid}) audit index\n\nGenerated by `python3 re/audit.py {game}`. Function bodies: `re/audit/{game}/fn/<addr>.c` (overlay source: re/out_{src}).\n'
                f'Fill `status.tsv` as you go. {len(rows)} functions ({len(ovl)} overlay, {len(engine)} engine called from it); '
                f'{len(uncited)} never cited in web/ (start there, biggest first).\n\n')
        f.write('| addr | kind | lines | cited in our code | notes | sfx ids | states | fx objs | callees |\n|---|---|---|---|---|---|---|---|---|\n')
        for r in sorted(rows, key=lambda r: (bool(r['cited']), -r['lines'])):
            f.write(f"| {r['a']} | {r['kind']} | {r['lines']} | {cell(r['cited'], 2) or '**none**'} | {r['notes'] or ''} | "
                    f"{cell(hexs(r['sfx']))} | {cell(r['states'])} | {cell(r['fx'])} | {cell(r['callees'], 5)} |\n")

    ours = game_code_ids(gid)
    with (out / 'sfx.md').open('w') as f:
        f.write(f'# {game} sound ids played by literal id\n\nIds not found anywhere in web/*/games/{gid}*.ts are flagged (heuristic: '
                'searches numeric literals, so a found id may still be wired wrongly).\n\n| id | dec | played in | in our code |\n|---|---|---|---|\n')
        for s in sorted(sfx_use):
            f.write(f"| {hex(s)} | {s} | {cell(sorted(sfx_use[s]), 6)} | {'yes' if s in ours else '**MISSING**'} |\n")
    missing = sum(1 for s in sfx_use if s not in ours)
    print(f'{game}: {len(rows)} fns ({len(uncited)} uncited), {len(sfx_use)} sfx ids ({missing} not in our code) -> {out.relative_to(ROOT)}')


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    c = citations()
    for g in (GAMES if which == 'all' else [which]):
        audit(g, c)
