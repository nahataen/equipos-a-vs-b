import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured } from './lib/supabase.js'
import './App.css'

const MAX_PER_TEAM = 5
const MAX_TOTAL = MAX_PER_TEAM * 2
const LS_KEY = 'team-players-v1'

const uid = () => Math.random().toString(36).slice(2, 10)
const shuffle = (arr) => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const SQL_PLAYERS = `create table if not exists players (
  id bigint generated always as identity primary key,
  name text not null,
  wins int default 0,
  created_at timestamptz default now()
);
alter table players enable row level security;
drop policy if exists "demo" on players;
create policy "demo" on players for all using (true) with check (true);`

function App() {
  const [players, setPlayers] = useState([])
  const [name, setName] = useState('')
  const [teamA, setTeamA] = useState([])
  const [teamB, setTeamB] = useState([])
  const [spinning, setSpinning] = useState(false)
  const [lastWinner, setLastWinner] = useState(null)
  const [status, setStatus] = useState('')

  // cargar
  useEffect(() => {
    const load = async () => {
      if (isSupabaseConfigured) {
        const { data, error } = await supabase
          .from('players')
          .select('*')
          .order('created_at', { ascending: true })
        if (error) {
          setStatus('Crea la tabla players con el SQL de abajo: ' + error.message)
        } else {
          setPlayers(data ?? [])
        }
      } else {
        try {
          const raw = localStorage.getItem(LS_KEY)
          if (raw) setPlayers(JSON.parse(raw))
        } catch {}
      }
    }
    load()
  }, [])

  // guardar local si no hay supabase
  useEffect(() => {
    if (!isSupabaseConfigured) {
      localStorage.setItem(LS_KEY, JSON.stringify(players))
    }
  }, [players])

  const addPlayer = async (e) => {
    e.preventDefault()
    const clean = name.trim()
    if (!clean) return
    if (players.length >= MAX_TOTAL) {
      setStatus(`Máximo ${MAX_TOTAL} jugadores (5 vs 5)`)
      return
    }
    if (players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      setStatus('Ese nombre ya existe')
      return
    }
    setStatus('')
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('players')
        .insert({ name: clean, wins: 0 })
        .select()
      if (error) setStatus(error.message)
      else setPlayers((prev) => [...prev, ...(data ?? [])])
    } else {
      setPlayers((prev) => [...prev, { id: uid(), name: clean, wins: 0 }])
    }
    setName('')
  }

  const removePlayer = async (id) => {
    setTeamA((t) => t.filter((p) => p.id !== id))
    setTeamB((t) => t.filter((p) => p.id !== id))
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('players').delete().eq('id', id)
      if (!error) setPlayers((prev) => prev.filter((p) => p.id !== id))
      else setStatus(error.message)
    } else {
      setPlayers((prev) => prev.filter((p) => p.id !== id))
    }
  }

  const clearTeams = () => {
    setTeamA([])
    setTeamB([])
    setLastWinner(null)
  }

  // RULETA RANDOM
  const assignRandom = () => {
    if (players.length < 2) {
      setStatus('Agrega al menos 2 jugadores (1v1 mínimo)')
      return
    }
    setStatus('')
    setSpinning(true)
    setLastWinner(null)
    // efecto ruleta: mezcla visual por 900ms
    let ticks = 0
    const interval = setInterval(() => {
      const s = shuffle(players)
      const mid = Math.ceil(s.length / 2)
      setTeamA(s.slice(0, mid))
      setTeamB(s.slice(mid))
      ticks++
      if (ticks >= 8) {
        clearInterval(interval)
        const final = shuffle(players)
        const m = Math.ceil(final.length / 2)
        setTeamA(final.slice(0, m))
        setTeamB(final.slice(m))
        setSpinning(false)
      }
    }, 110)
  }

  const registerWin = async (winner) => {
    const winners = winner === 'A' ? teamA : teamB
    if (winners.length === 0) return
    setLastWinner(winner)
    if (isSupabaseConfigured) {
      // suma +1 a cada ganador
      for (const p of winners) {
        await supabase
          .from('players')
          .update({ wins: (p.wins ?? 0) + 1 })
          .eq('id', p.id)
      }
      const { data } = await supabase
        .from('players')
        .select('*')
        .order('created_at', { ascending: true })
      if (data) {
        setPlayers(data)
        // refresca equipos con wins actualizados
        const map = new Map(data.map((p) => [p.id, p]))
        setTeamA((t) => t.map((p) => map.get(p.id) ?? p))
        setTeamB((t) => t.map((p) => map.get(p.id) ?? p))
      }
    } else {
      const ids = new Set(winners.map((p) => p.id))
      const next = players.map((p) =>
        ids.has(p.id) ? { ...p, wins: (p.wins ?? 0) + 1 } : p
      )
      const map = new Map(next.map((p) => [p.id, p]))
      setPlayers(next)
      setTeamA((t) => t.map((p) => map.get(p.id) ?? p))
      setTeamB((t) => t.map((p) => map.get(p.id) ?? p))
    }
  }

  const ranking = [...players].sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0))
  const mode = players.length === 0 ? '—' : `${Math.ceil(players.length / 2)}v${Math.floor(players.length / 2)}`

  return (
    <main className="m3-page">
      <header className="m3-topbar">
        <div className="m3-topbar-icon">
          <span className="material-symbols-rounded">sports_soccer</span>
        </div>
        <div>
          <h1>Equipos A vs B</h1>
          <p>Ruleta random • 1v1 hasta 5v5 • Ranking{!isSupabaseConfigured && ' • modo local'}</p>
        </div>
        <span className="m3-mode-badge">{mode}</span>
      </header>

      {status && (
        <div className="m3-alert">
          <span className="material-symbols-rounded">error</span>
          {status}
        </div>
      )}

      {!isSupabaseConfigured && (
        <details className="m3-card m3-sql">
          <summary><b>Conectar Supabase para ranking global (opcional)</b></summary>
          <ol>
            <li>Crea proyecto free en supabase.com</li>
            <li>SQL Editor → Run:</li>
          </ol>
          <pre>{SQL_PLAYERS}</pre>
          <p>Copia <code>.env.example</code> a <code>.env</code> con URL y anon key.</p>
        </details>
      )}

      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">group_add</span>
          <h2>Jugadores</h2>
          <span className="m3-count">{players.length}/{MAX_TOTAL}</span>
        </div>
        <p className="m3-support">Crea o quita jugadores. El modo se calcula solo.</p>
        <form onSubmit={addPlayer} className="m3-input-row">
          <div className="m3-field">
            <span className="material-symbols-rounded">person_add</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre del jugador..."
              maxLength={20}
            />
          </div>
          <button type="submit" className="m3-btn m3-btn-filled">
            <span className="material-symbols-rounded">add</span>
            Crear
          </button>
        </form>
        <div className="m3-chips">
          {players.map((p) => (
            <span key={p.id} className="m3-chip">
              {p.name}
              <span className="m3-wins-badge" style={{ padding: '2px 8px' }}>
                <span className="material-symbols-rounded trophy">trophy</span>
                {p.wins ?? 0}
              </span>
              <button onClick={() => removePlayer(p.id)} title="quitar" aria-label={`quitar ${p.name}`}>
                <span className="material-symbols-rounded">close</span>
              </button>
            </span>
          ))}
        </div>
        {players.length === 0 && <p className="m3-muted">Agrega jugadores para empezar.</p>}
      </section>

      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">casino</span>
          <h2>Ruleta random</h2>
        </div>
        <p className="m3-support">Mezcla y divide en Equipo A y B (máx 5 por lado).</p>
        <div className="m3-fab-row">
          <button onClick={assignRandom} disabled={spinning || players.length < 2} className="m3-btn m3-btn-filled">
            <span className="material-symbols-rounded">{spinning ? 'progress_activity' : 'shuffle'}</span>
            {spinning ? 'Girando...' : 'Asignar equipos random'}
          </button>
          <button onClick={clearTeams} className="m3-btn m3-btn-outlined">
            <span className="material-symbols-rounded">restart_alt</span>
            Limpiar
          </button>
        </div>
        <div className={`m3-teams ${spinning ? 'spinning' : ''}`}>
          <div className="m3-team a">
            <h3><span className="material-symbols-rounded">shield</span>Equipo A ({teamA.length})</h3>
            {teamA.map((p) => (
              <div key={p.id} className="m3-player">
                <span className="material-symbols-rounded">person</span>{p.name}
              </div>
            ))}
            {teamA.length === 0 && <span className="m3-muted">—</span>}
          </div>
          <div className="m3-vs">VS</div>
          <div className="m3-team b">
            <h3><span className="material-symbols-rounded">shield</span>Equipo B ({teamB.length})</h3>
            {teamB.map((p) => (
              <div key={p.id} className="m3-player">
                <span className="material-symbols-rounded">person</span>{p.name}
              </div>
            ))}
            {teamB.length === 0 && <span className="m3-muted">—</span>}
          </div>
        </div>
      </section>

      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">emoji_events</span>
          <h2>¿Quién ganó?</h2>
        </div>
        {teamA.length === 0 ? (
          <p className="m3-muted">Primero asigna los equipos.</p>
        ) : (
          <div className="m3-winner-actions">
            <button onClick={() => registerWin('A')} className="m3-btn m3-btn-tonal">
              <span className="material-symbols-rounded">trophy</span>
              Ganó A
            </button>
            <button onClick={() => registerWin('B')} className="m3-btn m3-btn-danger-tonal">
              <span className="material-symbols-rounded">trophy</span>
              Ganó B
            </button>
          </div>
        )}
        {lastWinner && (
          <div className="m3-winner-card">
            <span className="material-symbols-rounded">celebration</span>
            <div>
              <b>¡Ganó el Equipo {lastWinner}!</b><br />
              +1 win para: {(lastWinner === 'A' ? teamA : teamB).map((p) => p.name).join(', ')}
            </div>
          </div>
        )}
      </section>

      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">leaderboard</span>
          <h2>Ranking</h2>
        </div>
        {ranking.length === 0 ? (
          <p className="m3-muted">Sin datos aún.</p>
        ) : (
          <div className="m3-list">
            {ranking.map((p, i) => (
              <div key={p.id} className={`m3-list-row ${i === 0 ? 'top' : ''}`}>
                <span className="m3-rank">{i + 1}</span>
                <span className="m3-list-name">{p.name}</span>
                <span className="m3-wins-badge">
                  <span className="material-symbols-rounded">trophy</span>
                  {p.wins ?? 0} wins
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

export default App
