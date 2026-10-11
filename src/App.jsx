import { useEffect, useMemo, useState } from 'react'
import { supabase, isSupabaseConfigured } from './lib/supabase.js'
import './App.css'

const MAX_PER_TEAM = 5
const MAX_TOTAL = MAX_PER_TEAM * 2
const LS_PLAYERS = 'team-players-v2'
const LS_ACTIVE = 'team-active-v2'
const LS_ADMIN = 'm3-admin-v1'

const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || 'equipo123'

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
  // ranking histórico (nunca se borra al quitar del partido)
  const [allPlayers, setAllPlayers] = useState([])
  // ids que juegan el partido actual
  const [activeIds, setActiveIds] = useState([])
  const [name, setName] = useState('')
  const [teamA, setTeamA] = useState([])
  const [teamB, setTeamB] = useState([])
  const [spinning, setSpinning] = useState(false)
  const [lastWinner, setLastWinner] = useState(null)
  const [status, setStatus] = useState('')

  // admin
  const [isAdmin, setIsAdmin] = useState(() => sessionStorage.getItem(LS_ADMIN) === '1')
  const [pw, setPw] = useState('')
  const [showLogin, setShowLogin] = useState(false)

  const activePlayers = useMemo(
    () => allPlayers.filter((p) => activeIds.includes(p.id)),
    [allPlayers, activeIds]
  )
  const inactivePlayers = useMemo(
    () => allPlayers.filter((p) => !activeIds.includes(p.id)),
    [allPlayers, activeIds]
  )

  // cargar ranking
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
          setAllPlayers(data ?? [])
          // por defecto, todos activos la primera vez
          try {
            const savedActive = localStorage.getItem(LS_ACTIVE)
            if (savedActive) setActiveIds(JSON.parse(savedActive))
            else setActiveIds((data ?? []).map((p) => p.id))
          } catch {
            setActiveIds((data ?? []).map((p) => p.id))
          }
        }
      } else {
        try {
          const raw = localStorage.getItem(LS_PLAYERS)
          if (raw) {
            const list = JSON.parse(raw)
            setAllPlayers(list)
            const savedActive = localStorage.getItem(LS_ACTIVE)
            if (savedActive) setActiveIds(JSON.parse(savedActive))
            else setActiveIds(list.map((p) => p.id))
          }
        } catch {}
      }
    }
    load()
  }, [])

  // persistencia local
  useEffect(() => {
    if (!isSupabaseConfigured) {
      localStorage.setItem(LS_PLAYERS, JSON.stringify(allPlayers))
    }
  }, [allPlayers])
  useEffect(() => {
    localStorage.setItem(LS_ACTIVE, JSON.stringify(activeIds))
  }, [activeIds])

  const requireAdmin = () => {
    if (!isAdmin) {
      setStatus('Solo el admin puede editar. Inicia sesión con la contraseña.')
      setShowLogin(true)
      return false
    }
    return true
  }

  const login = (e) => {
    e.preventDefault()
    if (pw === ADMIN_PASSWORD) {
      setIsAdmin(true)
      sessionStorage.setItem(LS_ADMIN, '1')
      setShowLogin(false)
      setPw('')
      setStatus('')
    } else {
      setStatus('Contraseña incorrecta')
    }
  }
  const logout = () => {
    setIsAdmin(false)
    sessionStorage.removeItem(LS_ADMIN)
  }

  // crear o reactivar: si el nombre ya existe en ranking, solo entra al partido
  const addPlayer = async (e) => {
    e.preventDefault()
    if (!requireAdmin()) return
    const clean = name.trim()
    if (!clean) return
    const existing = allPlayers.find((p) => p.name.toLowerCase() === clean.toLowerCase())
    if (existing) {
      if (!activeIds.includes(existing.id)) {
        if (activePlayers.length >= MAX_TOTAL) {
          setStatus(`Partido lleno: máximo ${MAX_TOTAL} (5v5)`)
          return
        }
        setActiveIds((prev) => [...prev, existing.id])
      }
      setStatus(existing ? `"${existing.name}" ya estaba en ranking, entró al partido.` : '')
      setName('')
      return
    }
    if (activePlayers.length >= MAX_TOTAL) {
      setStatus(`Máximo ${MAX_TOTAL} jugadores en partido (5 vs 5)`)
      return
    }
    setStatus('')
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('players')
        .insert({ name: clean, wins: 0 })
        .select()
      if (error) setStatus(error.message)
      else if (data && data[0]) {
        setAllPlayers((prev) => [...prev, data[0]])
        setActiveIds((prev) => [...prev, data[0].id])
      }
    } else {
      const np = { id: uid(), name: clean, wins: 0 }
      setAllPlayers((prev) => [...prev, np])
      setActiveIds((prev) => [...prev, np.id])
    }
    setName('')
  }

  // quitar del PARTIDO (conserva ranking e historial de wins)
  const removeFromMatch = (id) => {
    if (!requireAdmin()) return
    setActiveIds((prev) => prev.filter((x) => x !== id))
    setTeamA((t) => t.filter((p) => p.id !== id))
    setTeamB((t) => t.filter((p) => p.id !== id))
  }

  const joinMatch = (id) => {
    if (!requireAdmin()) return
    if (activePlayers.length >= MAX_TOTAL) {
      setStatus(`Partido lleno: máximo ${MAX_TOTAL}`)
      return
    }
    setActiveIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }

  // borrado DEFINITIVO del ranking (solo admin, con confirm)
  const deleteFromRanking = async (id, playerName) => {
    if (!requireAdmin()) return
    if (!window.confirm(`¿Borrar a "${playerName}" del ranking para siempre? Sus wins se pierden.`)) return
    removeFromMatchSilent(id)
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('players').delete().eq('id', id)
      if (!error) setAllPlayers((prev) => prev.filter((p) => p.id !== id))
      else setStatus(error.message)
    } else {
      setAllPlayers((prev) => prev.filter((p) => p.id !== id))
    }
  }
  const removeFromMatchSilent = (id) => {
    setActiveIds((prev) => prev.filter((x) => x !== id))
    setTeamA((t) => t.filter((p) => p.id !== id))
    setTeamB((t) => t.filter((p) => p.id !== id))
  }

  const clearTeams = () => {
    if (!requireAdmin()) return
    setTeamA([])
    setTeamB([])
    setLastWinner(null)
  }

  // RULETA RANDOM (solo con los del partido actual)
  const assignRandom = () => {
    if (!requireAdmin()) return
    if (activePlayers.length < 2) {
      setStatus('Agrega al menos 2 jugadores al partido (1v1 mínimo)')
      return
    }
    setStatus('')
    setSpinning(true)
    setLastWinner(null)
    let ticks = 0
    const interval = setInterval(() => {
      const s = shuffle(activePlayers)
      const mid = Math.ceil(s.length / 2)
      setTeamA(s.slice(0, mid))
      setTeamB(s.slice(mid))
      ticks++
      if (ticks >= 8) {
        clearInterval(interval)
        const final = shuffle(activePlayers)
        const m = Math.ceil(final.length / 2)
        setTeamA(final.slice(0, m))
        setTeamB(final.slice(m))
        setSpinning(false)
      }
    }, 110)
  }

  const registerWin = async (winner) => {
    if (!requireAdmin()) return
    const winners = winner === 'A' ? teamA : teamB
    if (winners.length === 0) return
    setLastWinner(winner)
    if (isSupabaseConfigured) {
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
        setAllPlayers(data)
        const map = new Map(data.map((p) => [p.id, p]))
        setTeamA((t) => t.map((p) => map.get(p.id) ?? p))
        setTeamB((t) => t.map((p) => map.get(p.id) ?? p))
      }
    } else {
      const ids = new Set(winners.map((p) => p.id))
      const next = allPlayers.map((p) =>
        ids.has(p.id) ? { ...p, wins: (p.wins ?? 0) + 1 } : p
      )
      const map = new Map(next.map((p) => [p.id, p]))
      setAllPlayers(next)
      setTeamA((t) => t.map((p) => map.get(p.id) ?? p))
      setTeamB((t) => t.map((p) => map.get(p.id) ?? p))
    }
  }

  const ranking = [...allPlayers].sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0))
  const mode =
    activePlayers.length === 0
      ? '—'
      : `${Math.ceil(activePlayers.length / 2)}v${Math.floor(activePlayers.length / 2)}`

  return (
    <main className="m3-page">
      <header className="m3-topbar">
        <div className="m3-topbar-icon">
          <span className="material-symbols-rounded">swords</span>
        </div>
        <div>
          <h1>Equipos A vs B</h1>
          <p>Ruleta random • 1v1 hasta 5v5 • Ranking{!isSupabaseConfigured && ' • modo local'}</p>
        </div>
        <span className="m3-mode-badge">{mode}</span>
        {isAdmin ? (
          <button onClick={logout} className="m3-btn m3-btn-outlined" title="Cerrar sesión admin">
            <span className="material-symbols-rounded">lock_open</span>
            Admin
          </button>
        ) : (
          <button onClick={() => setShowLogin((v) => !v)} className="m3-btn m3-btn-outlined" title="Entrar como admin">
            <span className="material-symbols-rounded">lock</span>
            Ver
          </button>
        )}
      </header>

      {showLogin && !isAdmin && (
        <section className="m3-card">
          <div className="m3-card-head">
            <span className="material-symbols-rounded">key</span>
            <h2>Solo lectura — entra como admin para editar</h2>
          </div>
          <form onSubmit={login} className="m3-input-row">
            <div className="m3-field">
              <span className="material-symbols-rounded">password</span>
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Contraseña de admin..."
              />
            </div>
            <button type="submit" className="m3-btn m3-btn-filled">
              <span className="material-symbols-rounded">login</span>
              Entrar
            </button>
          </form>
          <p className="m3-muted">Los demás solo ven resultados, no pueden editar.</p>
        </section>
      )}

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
          <p>Copia <code>.env.example</code> a <code>.env</code> con URL, anon key y admin password.</p>
        </details>
      )}

      <div className="m3-grid">
        <div className="m3-col">
      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">group_add</span>
          <h2>Partido actual</h2>
          <span className="m3-count">{activePlayers.length}/{MAX_TOTAL} • {mode}</span>
        </div>
        <p className="m3-support">
          {isAdmin
            ? 'Crea jugadores o mete a alguien del ranking. Quitar del partido NO borra sus wins.'
            : 'Modo lectura: pide al admin para cambiar jugadores.'}
        </p>
        <form onSubmit={addPlayer} className="m3-input-row">
          <div className="m3-field">
            <span className="material-symbols-rounded">person_add</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre del jugador..."
              maxLength={20}
              disabled={!isAdmin}
            />
          </div>
          <button type="submit" className="m3-btn m3-btn-filled" disabled={!isAdmin} title={!isAdmin ? 'Solo admin' : ''}>
            <span className="material-symbols-rounded">add</span>
            Crear / Entrar
          </button>
        </form>
        <div className="m3-chips">
          {activePlayers.map((p) => (
            <span key={p.id} className="m3-chip">
              {p.name}
              <span className="m3-wins-badge" style={{ padding: '2px 8px' }}>
                <span className="material-symbols-rounded trophy">trophy</span>
                {p.wins ?? 0}
              </span>
              {isAdmin && (
                <button onClick={() => removeFromMatch(p.id)} title="quitar del partido (conserva ranking)" aria-label={`quitar ${p.name} del partido`}>
                  <span className="material-symbols-rounded">close</span>
                </button>
              )}
            </span>
          ))}
        </div>
        {activePlayers.length === 0 && <p className="m3-muted">Sin jugadores en este partido. Mete del ranking o crea nuevos.</p>}

        {inactivePlayers.length > 0 && (
          <>
            <p className="m3-support" style={{ marginTop: 14 }}>En ranking pero fuera del partido:</p>
            <div className="m3-chips">
              {inactivePlayers.map((p) => (
                <span key={p.id} className="m3-chip" style={{ opacity: .75 }}>
                  {p.name} ({p.wins ?? 0})
                  {isAdmin && (
                    <button onClick={() => joinMatch(p.id)} title="meter al partido" aria-label={`meter ${p.name}`}>
                      <span className="material-symbols-rounded">add</span>
                    </button>
                  )}
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">casino</span>
          <h2>Ruleta random</h2>
        </div>
        <p className="m3-support">Mezcla solo a los del partido actual (máx 5 por lado).</p>
        <div className="m3-fab-row">
          <button onClick={assignRandom} disabled={spinning || activePlayers.length < 2 || !isAdmin} className="m3-btn m3-btn-filled" title={!isAdmin ? 'Solo admin' : ''}>
            <span className="material-symbols-rounded">{spinning ? 'progress_activity' : 'shuffle'}</span>
            {spinning ? 'Girando...' : 'Asignar equipos random'}
          </button>
          <button onClick={clearTeams} className="m3-btn m3-btn-outlined" disabled={!isAdmin}>
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

        </div>
        <div className="m3-col">
      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">emoji_events</span>
          <h2>¿Quién ganó?</h2>
        </div>
        {teamA.length === 0 ? (
          <p className="m3-muted">Primero asigna los equipos.</p>
        ) : (
          <div className="m3-winner-actions">
            <button onClick={() => registerWin('A')} className="m3-btn m3-btn-tonal" disabled={!isAdmin} title={!isAdmin ? 'Solo admin' : ''}>
              <span className="material-symbols-rounded">trophy</span>
              Ganó A
            </button>
            <button onClick={() => registerWin('B')} className="m3-btn m3-btn-danger-tonal" disabled={!isAdmin} title={!isAdmin ? 'Solo admin' : ''}>
              <span className="material-symbols-rounded">trophy</span>
              Ganó B
            </button>
          </div>
        )}
        {!isAdmin && teamA.length > 0 && <p className="m3-muted">Solo el admin registra el ganador.</p>}
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
          <h2>Ranking histórico</h2>
        </div>
        <p className="m3-support">Se conserva aunque salgan del partido. Solo admin puede borrar definitivo.</p>
        {ranking.length === 0 ? (
          <p className="m3-muted">Sin datos aún.</p>
        ) : (
          <div className="m3-list">
            {ranking.map((p, i) => (
              <div key={p.id} className={`m3-list-row ${i === 0 ? 'top' : ''}`}>
                <span className="m3-rank">{i + 1}</span>
                <span className="m3-list-name">
                  {p.name}
                  {!activeIds.includes(p.id) && <span className="m3-muted"> • fuera</span>}
                </span>
                <span className="m3-wins-badge">
                  <span className="material-symbols-rounded">trophy</span>
                  {p.wins ?? 0} wins
                </span>
                {isAdmin && (
                  <button
                    onClick={() => deleteFromRanking(p.id, p.name)}
                    className="m3-btn m3-btn-outlined"
                    style={{ height: 36, padding: '0 12px' }}
                    title="Borrar definitivo del ranking"
                  >
                    <span className="material-symbols-rounded">delete</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
        </div>
      </div>
    </main>
  )
}

export default App
