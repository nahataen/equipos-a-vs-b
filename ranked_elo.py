"""Ranked estilo LoL basado en Elo (MMR oculto).
Reglas: MMR inicial 1000, K=32, esperado = 1/(1+10^((B-A)/400)),
cambio = round(32*(resultado-esperado)) igual para todo el equipo,
MMR con piso 0. Se muestra solo: puntos_rango = MMR-1000+400.
Agrega partidas a GAMES y corre: python ranked_elo.py
"""
import math

K = 32
MIN_GAMES = 5
TIERS = ['Hierro', 'Bronce', 'Plata', 'Oro', 'Platino', 'Esmeralda', 'Diamante']

GAMES = [
    {'w': ['nataen', 'roxas', 'djuanchito', 'poppa', 'hanubi'], 'l': ['neid', 'junko', 'blubby', 'hanz', 'mika']},
    {'w': ['djuanchito', 'hanubi', 'neid', 'blubby', 'poppa'], 'l': ['nataen', 'junko', 'hanz', 'mika', 'roxas']},
    {'w': ['nataen', 'hanubi', 'neid', 'blubby', 'junko'], 'l': ['mika', 'roxas', 'hanz', 'djuanchito', 'poppa']},
    {'w': ['hanubi', 'blubby', 'djuanchito', 'mika', 'fairy'], 'l': ['nataen', 'roxas', 'hanz', 'junko', 'neid']},
    {'w': ['nataen', 'hanz', 'junko', 'neid', 'djuanchito'], 'l': ['hanubi', 'blubby', 'mika', 'fairy', 'roxas']},
    {'w': ['blubby', 'mika', 'junko', 'djuanchito', 'hanz'], 'l': ['nataen', 'roxas', 'neid', 'hanubi', 'fairy']},
    {'w': ['blubby', 'junko', 'roxas', 'fairy', 'neid'], 'l': ['nataen', 'mika', 'djuanchito', 'hanz', 'hanubi']},
    {'w': ['junko', 'roxas', 'hanz', 'mika', 'hanubi'], 'l': ['nataen', 'djuanchito', 'neid', 'fairy', 'blubby']},
]
EXTRA = ['sanns']
NAMES = {'nataen': 'Nataen', 'roxas': 'Roxas', 'djuanchito': 'DJuanchito', 'poppa': 'Poppa',
         'hanubi': 'Hanubi', 'neid': 'Neid', 'junko': 'Junko', 'blubby': 'Blubby',
         'hanz': 'Hanz', 'mika': 'Mika', 'fairy': 'Fairy', 'sanns': 'Sanns'}


def rhalf(x):
    return math.floor(x + 0.5) if x >= 0 else math.ceil(x - 0.5)


def rank_label(puntos):
    if puntos >= 2800:
        return 'Maestro'
    tier = TIERS[puntos // 400]
    div = ['IV', 'III', 'II', 'I'][(puntos % 400) // 100]
    return f'{tier} {div} - {puntos % 100} LP'


mmr = {n: 1000 for n in {x for g in GAMES for x in g['w'] + g['l']} | set(EXTRA)}
st = {n: {'wins': 0, 'losses': 0, 'hist': []} for n in mmr}
coherent = True
for i, g in enumerate(GAMES, 1):
    avg_w = sum(mmr[n] for n in g['w']) / 5
    avg_l = sum(mmr[n] for n in g['l']) / 5
    exp_w = 1 / (1 + 10 ** ((avg_l - avg_w) / 400))
    d_w, d_l = rhalf(K * (1 - exp_w)), rhalf(K * (0 - (1 - exp_w)))
    print(f'P{i}: avgW={avg_w:.1f} avgL={avg_l:.1f} P(ganen)={exp_w:.3f} -> ganadores {d_w:+d} / perdedores {d_l:+d}')
    if not (d_w > 0 and d_l < 0):
        coherent = False
    for n in g['w']:
        st[n]['wins'] += 1
        mmr[n] = max(0, mmr[n] + d_w)
        st[n]['hist'].append((i, d_w, mmr[n] - 600))
    for n in g['l']:
        st[n]['losses'] += 1
        mmr[n] = max(0, mmr[n] + d_l)
        st[n]['hist'].append((i, d_l, mmr[n] - 600))

rows = []
for n, s in st.items():
    games = s['wins'] + s['losses']
    rows.append({'n': n, 'games': games, 'wins': s['wins'], 'losses': s['losses'],
                 'puntos': mmr[n] - 600, 'wr': s['wins'] / games if games else None, 'hist': s['hist']})

tw = sum(r['wins'] for r in rows)
tl = sum(r['losses'] for r in rows)
print(f'\nVERIF a) wins={tw} loses={tl} -> {"OK" if tw == tl else "MAL"}')
print(f"VERIF b) W+L=partidas -> {'OK' if all(r['wins'] + r['losses'] == r['games'] for r in rows) else 'MAL'}")
print(f'VERIF c) ganadores suben y perdedores bajan en las 8 -> {"OK" if coherent else "MAL"}')

rows.sort(key=lambda r: (-r['puntos'], -(r['wr'] if r['wr'] is not None else -1), -r['games'], r['n']))
print('\n#  Jugador      Rango                PJ  W  L  WR%')
for i, r in enumerate(rows, 1):
    rango = 'En colocación' if r['games'] < MIN_GAMES else rank_label(r['puntos'])
    wr = '—' if r['wr'] is None else f'{r["wr"] * 100:5.1f}'
    print(f'{i:2} {(NAMES[r["n"]]).ljust(12)} {rango.ljust(20)} {r["games"]:2}  {r["wins"]}  {r["losses"]}  {wr}')
print('\nHISTORIAL (rango tras cada partida jugada):')
for r in rows:
    if not r['hist']:
        print(f'- {NAMES[r["n"]]}: sin partidas')
        continue
    prev = 400
    parts = []
    for gi, d, pts in r['hist']:
        parts.append(f'P{gi}:{d:+d}->[{rank_label(pts)}]')
        prev = pts
    print(f'- {NAMES[r["n"]]}: ' + ' | '.join(parts))
