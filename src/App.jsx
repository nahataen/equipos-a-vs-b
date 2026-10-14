import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from './lib/supabase.js'
import './App.css'

const MAX_PER_TEAM = 5
const MAX_TOTAL = MAX_PER_TEAM * 2
const LS_PLAYERS = 'team-players-v2'
const LS_ACTIVE = 'team-active-v2'
const LS_ADMIN = 'm3-admin-v1'
const LS_HISTORY = 'team-winhistory-v1'

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

const WIN_PTS = 20
const LOSS_PTS = 20

// Estilo Riot: 100 pts por división, LP = resto dentro del rango
const RANKS = ['Hierro', 'Bronce', 'Plata', 'Oro', 'Platino', 'Esmeralda', 'Diamante', 'Maestro']
const getPoints = (p) => p.points ?? (p.wins ?? 0) * WIN_PTS
const getLosses = (p) => p.losses ?? 0
const getStreak = (p) => p.streak ?? 0
const getPentas = (p) => p.pentakills ?? 0
const FIRE_STREAK = 2 // racha mínima para mostrar fuego
const getRank = (points) => {
  const i = Math.min(Math.floor(Math.max(0, points) / 100), RANKS.length - 1)
  return { name: RANKS[i], lp: Math.max(0, points) % 100 }
}

const SQL_PLAYERS = `create table if not exists players (
  id bigint generated always as identity primary key,
  name text not null,
  wins int default 0,
  losses int default 0,
  points int default 0,
  streak int default 0,
  pentakills int default 0,
  avatar text,
  created_at timestamptz default now()
);
alter table players enable row level security;
drop policy if exists "demo" on players;
create policy "demo" on players for all using (true) with check (true);
-- si tu tabla ya existe, corre esto para migrar a ranked estilo Riot:
-- alter table players add column if not exists losses int default 0;
-- alter table players add column if not exists points int default 0;
-- alter table players add column if not exists streak int default 0;
-- alter table players add column if not exists pentakills int default 0;
-- alter table players add column if not exists avatar text;
-- update players set points = wins * 20 where points = 0 and wins > 0;`

// comprime la foto a 512px para que se vea nítida en grande y en chico
const compressAvatar = (file) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const S = 512
      const canvas = document.createElement('canvas')
      canvas.width = S
      canvas.height = S
      const ctx = canvas.getContext('2d')
      const side = Math.min(img.width, img.height)
      ctx.drawImage(
        img,
        (img.width - side) / 2, (img.height - side) / 2, side, side,
        0, 0, S, S
      )
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = reject
    img.src = url
  })

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
  // historial de victorias para deshacer errores (solo en este dispositivo)
  const [winHistory, setWinHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_HISTORY) ?? '[]')
    } catch {
      return []
    }
  })
  // foto de perfil: qué jugador se está editando
  const [avatarFor, setAvatarFor] = useState(null)
  const [preview, setPreview] = useState(null) // {src, name} para visitantes
  const fileRef = useRef(null)

  // Esc cierra la vista previa y el login
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPreview(null)
        setShowLogin(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // admin
  const [isAdmin, setIsAdmin] = useState(() => sessionStorage.getItem(LS_ADMIN) === '1')
  const [pw, setPw] = useState('')
  const [showLogin, setShowLogin] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [loginError, setLoginError] = useState(false)

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
  useEffect(() => {
    localStorage.setItem(LS_HISTORY, JSON.stringify(winHistory.slice(0, 10)))
  }, [winHistory])

  const requireAdmin = () => {
    if (!isAdmin) {
      setStatus('Solo el admin puede editar. Inicia sesión con la contraseña.')
      setShowLogin(true)
      return false
    }
    return true
  }

  const closeLogin = () => {
    setShowLogin(false)
    setPw('')
    setLoginError(false)
    setShowPw(false)
  }

  const login = (e) => {
    e.preventDefault()
    if (pw === ADMIN_PASSWORD) {
      setIsAdmin(true)
      sessionStorage.setItem(LS_ADMIN, '1')
      closeLogin()
      setStatus('')
    } else {
      setLoginError(true)
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
        .insert({ name: clean, wins: 0, losses: 0, points: 0, streak: 0, pentakills: 0 })
        .select()
      if (error) setStatus(error.message)
      else if (data && data[0]) {
        setAllPlayers((prev) => [...prev, data[0]])
        setActiveIds((prev) => [...prev, data[0].id])
      }
    } else {
      const np = { id: uid(), name: clean, wins: 0, losses: 0, points: 0, streak: 0, pentakills: 0 }
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

  // Estilo Riot: ganadores +WIN_PTS, perdedores −LOSS_PTS (piso 0)
  const registerWin = async (winner) => {
    if (!requireAdmin()) return
    const winners = winner === 'A' ? teamA : teamB
    const losers = winner === 'A' ? teamB : teamA
    if (winners.length === 0) return
    setLastWinner(winner)
    const entry = {
      key: uid() + Date.now().toString(36),
      winner,
      ids: winners.map((p) => p.id),
      loserIds: losers.map((p) => p.id),
      names: winners.map((p) => p.name),
      loserNames: losers.map((p) => p.name),
      prevStreaks: Object.fromEntries(allPlayers.map((p) => [p.id, getStreak(p)])),
      at: new Date().toISOString(),
    }
    const applyRanked = (list) =>
      list.map((p) => {
        if (entry.ids.includes(p.id))
          return { ...p, wins: (p.wins ?? 0) + 1, points: getPoints(p) + WIN_PTS, streak: getStreak(p) + 1 }
        if (entry.loserIds.includes(p.id))
          return { ...p, losses: getLosses(p) + 1, points: Math.max(0, getPoints(p) - LOSS_PTS), streak: 0 }
        return p
      })
    if (isSupabaseConfigured) {
      for (const p of winners) {
        await supabase
          .from('players')
          .update({ wins: (p.wins ?? 0) + 1, points: getPoints(p) + WIN_PTS, streak: getStreak(p) + 1 })
          .eq('id', p.id)
      }
      for (const p of losers) {
        await supabase
          .from('players')
          .update({ losses: getLosses(p) + 1, points: Math.max(0, getPoints(p) - LOSS_PTS), streak: 0 })
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
      const next = applyRanked(allPlayers)
      const map = new Map(next.map((p) => [p.id, p]))
      setAllPlayers(next)
      setTeamA((t) => t.map((p) => map.get(p.id) ?? p))
      setTeamB((t) => t.map((p) => map.get(p.id) ?? p))
    }
    setWinHistory((prev) => [entry, ...prev].slice(0, 10))
  }

  // deshace un registro erróneo: ganadores −WIN_PTS, perdedores +LOSS_PTS, rachas restauradas
  const undoWin = async (entry) => {
    if (!requireAdmin()) return
    const idSet = new Set(entry.ids)
    const loserSet = new Set(entry.loserIds ?? [])
    const prev = entry.prevStreaks ?? {}
    const restoreStreak = (p) => (prev[p.id] ?? Math.max(0, getStreak(p) - (idSet.has(p.id) ? 1 : 0)))
    if (isSupabaseConfigured) {
      for (const p of allPlayers.filter((p) => idSet.has(p.id))) {
        await supabase
          .from('players')
          .update({ wins: Math.max(0, (p.wins ?? 0) - 1), points: Math.max(0, getPoints(p) - WIN_PTS), streak: restoreStreak(p) })
          .eq('id', p.id)
      }
      for (const p of allPlayers.filter((p) => loserSet.has(p.id))) {
        await supabase
          .from('players')
          .update({ losses: Math.max(0, getLosses(p) - 1), points: getPoints(p) + LOSS_PTS, streak: restoreStreak(p) })
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
      const next = allPlayers.map((p) => {
        if (idSet.has(p.id))
          return { ...p, wins: Math.max(0, (p.wins ?? 0) - 1), points: Math.max(0, getPoints(p) - WIN_PTS), streak: restoreStreak(p) }
        if (loserSet.has(p.id))
          return { ...p, losses: Math.max(0, getLosses(p) - 1), points: getPoints(p) + LOSS_PTS, streak: restoreStreak(p) }
        return p
      })
      const map = new Map(next.map((p) => [p.id, p]))
      setAllPlayers(next)
      setTeamA((t) => t.map((p) => map.get(p.id) ?? p))
      setTeamB((t) => t.map((p) => map.get(p.id) ?? p))
    }
    setWinHistory((prev) => prev.filter((h) => h.key !== entry.key))
    setLastWinner(null)
    setStatus(`Se deshizo: Equipo ${entry.winner} (−1 win a: ${entry.names.join(', ')})`)
  }

  // contador de pentakills (solo admin, +1 / −1 sin bajar de 0)
  const bumpPenta = async (p, delta) => {
    if (!requireAdmin()) return
    const next = Math.max(0, getPentas(p) + delta)
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('players').update({ pentakills: next }).eq('id', p.id)
      if (error) {
        setStatus(
          error.message.includes('pentakills')
            ? 'Corre en Supabase → SQL: alter table players add column if not exists pentakills int default 0;'
            : error.message
        )
        return
      }
    }
    const applyTo = (list) => list.map((x) => (x.id === p.id ? { ...x, pentakills: next } : x))
    setAllPlayers((prev) => applyTo(prev))
    setTeamA((t) => applyTo(t))
    setTeamB((t) => applyTo(t))
  }

  // clic en foto/nombre del ranking:
  // admin → asignar foto | visitante → verla en grande (sin editar)
  const onAvatarClick = (p) => {
    if (isAdmin) {
      setAvatarFor(p.id)
      fileRef.current?.click()
      return
    }
    if (p.avatar) setPreview({ src: p.avatar, name: p.name })
  }

  const onAvatarFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !avatarFor) return
    if (!file.type.startsWith('image/')) {
      setStatus('El archivo debe ser una imagen')
      return
    }
    try {
      const dataUrl = await compressAvatar(file)
      const applyTo = (list) =>
        list.map((p) => (p.id === avatarFor ? { ...p, avatar: dataUrl } : p))
      if (isSupabaseConfigured) {
        const { error } = await supabase
          .from('players')
          .update({ avatar: dataUrl })
          .eq('id', avatarFor)
        if (error) {
          setStatus(
            error.message.includes('avatar')
              ? 'Corre en Supabase → SQL: alter table players add column if not exists avatar text;'
              : error.message
          )
          return
        }
      }
      setAllPlayers((prev) => applyTo(prev))
      setTeamA((t) => applyTo(t))
      setTeamB((t) => applyTo(t))
      setStatus('Foto actualizada')
    } catch {
      setStatus('No se pudo leer la imagen')
    }
    setAvatarFor(null)
  }

  const ranking = [...allPlayers].sort((a, b) => getPoints(b) - getPoints(a) || (b.wins ?? 0) - (a.wins ?? 0))
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
          <button onClick={() => setShowLogin(true)} className="m3-btn m3-btn-outlined" title="Entrar como admin">
            <span className="material-symbols-rounded">login</span>
            Entrar
          </button>
        )}
      </header>

      {showLogin && !isAdmin && (
        <div className="m3-login-backdrop" onClick={closeLogin}>
          <div
            className={`m3-login-card ${loginError ? 'shake' : ''}`}
            key={loginError ? 'err' : 'ok'}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Acceso admin"
          >
            <button onClick={closeLogin} className="m3-login-close" aria-label="Cerrar">
              <span className="material-symbols-rounded">close</span>
            </button>
            <div className="m3-login-icon">
              <span className="material-symbols-rounded">admin_panel_settings</span>
            </div>
            <h2>Acceso admin</h2>
            <p className="m3-muted">Solo el admin puede crear jugadores y registrar resultados. Los demás ven todo en modo lectura.</p>
            <form onSubmit={login}>
              <div className={`m3-field m3-pw-field ${loginError ? 'm3-field-error' : ''}`}>
                <span className="material-symbols-rounded">password</span>
                <input
                  autoFocus
                  type={showPw ? 'text' : 'password'}
                  value={pw}
                  onChange={(e) => { setPw(e.target.value); setLoginError(false) }}
                  placeholder="Contraseña de admin..."
                  aria-label="Contraseña de admin"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="m3-pw-toggle"
                  title={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  aria-label={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  <span className="material-symbols-rounded">{showPw ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
              {loginError && <p className="m3-login-error">Contraseña incorrecta, intenta de nuevo.</p>}
              <button type="submit" className="m3-btn m3-btn-filled m3-login-submit">
                <span className="material-symbols-rounded">login</span>
                Entrar como admin
              </button>
            </form>
          </div>
        </div>
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
            ? 'Crea jugadores o mete a alguien del ranking. Quitar del partido NO borra sus puntos.'
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
                <span className="material-symbols-rounded trophy">military_tech</span>
                {getPoints(p)}
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
                  {p.name} ({getPoints(p)} pts)
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
        {lastWinner && winHistory.length > 0 && (
          <div className="m3-winner-card m3-confetti">
            <span className="m3-confetti-particles" aria-hidden="true">
              {Array.from({ length: 16 }).map((_, k) => (
                <i key={k} style={{ left: `${(k * 61) % 100}%`, animationDelay: `${(k % 8) * 0.12}s` }} />
              ))}
            </span>
            <span className="material-symbols-rounded">celebration</span>
            <div style={{ flex: 1 }}>
              <b>¡Ganó el Equipo {lastWinner}!</b><br />
              +{WIN_PTS} pts para: {(lastWinner === 'A' ? teamA : teamB).map((p) => p.name).join(', ')}<br />
              −{LOSS_PTS} pts para: {(lastWinner === 'A' ? teamB : teamA).map((p) => p.name).join(', ') || '—'}
            </div>
            {isAdmin && (
              <button onClick={() => undoWin(winHistory[0])} className="m3-btn m3-btn-outlined" style={{ height: 40 }} title="Deshacer este registro">
                <span className="material-symbols-rounded">undo</span>
                Deshacer
              </button>
            )}
          </div>
        )}
        {isAdmin && winHistory.length > 1 && (
          <>
            <p className="m3-support" style={{ marginTop: 14 }}>Historial reciente (por si hubo un error):</p>
            <div className="m3-list" style={{ maxHeight: 220 }}>
              {winHistory.slice(1).map((h) => (
                <div key={h.key} className="m3-list-row">
                  <span className="material-symbols-rounded">history</span>
                  <span className="m3-list-name">
                    Equipo {h.winner} +{WIN_PTS}/−{LOSS_PTS} ({h.names.join(', ')})
                  </span>
                  <button
                    onClick={() => undoWin(h)}
                    className="m3-btn m3-btn-outlined"
                    style={{ height: 36, padding: '0 12px' }}
                    title="Deshacer este registro"
                  >
                    <span className="material-symbols-rounded">undo</span>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        {isAdmin && winHistory.length === 0 && !lastWinner && (
          <p className="m3-muted">Si te equivocas de equipo, deshaz el registro y vuelve a marcar el correcto.</p>
        )}
      </section>

      <section className="m3-card">
        <div className="m3-card-head">
          <span className="material-symbols-rounded">leaderboard</span>
          <h2>Ranking histórico</h2>
        </div>
        <p className="m3-support">Se conserva aunque salgan del partido. Ganar +{WIN_PTS} pts, perder −{LOSS_PTS} pts. Solo admin puede borrar definitivo.</p>
        {ranking.length === 0 ? (
          <p className="m3-muted">Sin datos aún.</p>
        ) : (
          <div className="m3-list">
            {ranking.map((p, i) => {
              const pts = getPoints(p)
              const r = getRank(pts)
              const w = p.wins ?? 0
              const l = getLosses(p)
              const st = getStreak(p)
              const pe = getPentas(p)
              const total = w + l
              const wr = total ? Math.round((w / total) * 100) : 0
              const onFire = st >= FIRE_STREAK
              return (
              <div
                key={p.id}
                className={`m3-list-row rank-in ${i === 0 ? 'top' : ''} ${onFire ? 'on-fire' : ''}`}
                style={{ animationDelay: `${Math.min(i, 10) * 0.05}s` }}
              >
                <button
                  onClick={() => onAvatarClick(p)}
                  className="m3-avatar"
                  title={isAdmin ? `Cambiar foto de ${p.name}` : p.name}
                  aria-label={`Foto de ${p.name}`}
                >
                  {p.avatar ? (
                    <img src={p.avatar} alt={p.name} />
                  ) : (
                    <span className="m3-avatar-fallback">
                      {p.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                  {isAdmin && (
                    <span className="m3-avatar-edit">
                      <span className="material-symbols-rounded">photo_camera</span>
                    </span>
                  )}
                </button>
                <span className="m3-list-name">
                  {isAdmin ? (
                    <button onClick={() => onAvatarClick(p)} className="m3-name-btn" title={`Cambiar foto de ${p.name}`}>
                      {p.name}
                    </button>
                  ) : p.avatar ? (
                    <button onClick={() => onAvatarClick(p)} className="m3-name-btn" title="Ver foto">
                      {p.name}
                    </button>
                  ) : (
                    p.name
                  )}
                  <br />
                  <span className="m3-muted">{r.name} {r.lp} LP • {w}W {l}L • {wr}%</span>
                  {onFire && (
                    <span className="m3-fire" title={`Racha de ${st} victorias`}>
                      <span className="material-symbols-rounded">local_fire_department</span>
                      x{st}
                    </span>
                  )}
                  {pe > 0 && (
                    <span className="m3-penta" title={`${pe} pentakills`}>
                      <span className="material-symbols-rounded">swords</span>
                      Penta x{pe}
                    </span>
                  )}
                  {!activeIds.includes(p.id) && <span className="m3-muted"> • fuera</span>}
                </span>
                <span className="m3-wins-badge">
                  <span className="material-symbols-rounded">military_tech</span>
                  {pts} pts
                </span>
                {isAdmin && (
                  <>
                    <span className="m3-penta-stepper" title="Contador de pentakills">
                      <button onClick={() => bumpPenta(p, -1)} aria-label={`quitar pentakill a ${p.name}`}>−</button>
                      <button onClick={() => bumpPenta(p, 1)} aria-label={`sumar pentakill a ${p.name}`}>+</button>
                    </span>
                    <button
                      onClick={() => deleteFromRanking(p.id, p.name)}
                      className="m3-btn m3-btn-outlined"
                      style={{ height: 36, padding: '0 12px' }}
                      title="Borrar definitivo del ranking"
                    >
                      <span className="material-symbols-rounded">delete</span>
                    </button>
                  </>
                )}
              </div>
              )
            })}
          </div>
        )}
      </section>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onAvatarFile}
      />
      {preview && (
        <div className="m3-lightbox" onClick={() => setPreview(null)}>
          <div className="m3-lightbox-card" onClick={(e) => e.stopPropagation()}>
            <img src={preview.src} alt={preview.name} />
            <p>{preview.name}</p>
            <button onClick={() => setPreview(null)} className="m3-btn m3-btn-tonal">
              <span className="material-symbols-rounded">close</span>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
