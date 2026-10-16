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
// PGRST204 = la columna no existe en la tabla (falta migrar en Supabase SQL)
const isSchemaCacheError = (error) => error?.code === 'PGRST204'
// intenta el update completo (ranked); si faltan columnas, reintenta con el mínimo
const safeUpdate = async (id, full, minimal) => {
  const first = await supabase.from('players').update(full).eq('id', id)
  if (!first.error) return first
  if (isSchemaCacheError(first.error) && minimal) {
    if (Object.keys(minimal).length === 0) return { error: null }
    return await supabase.from('players').update(minimal).eq('id', id)
  }
  return first
}
const shuffle = (arr) => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Elo (MMR oculto): K=32, base 1000, piso 0. El cambio se calcula con el
// promedio de cada equipo y es el mismo para todo el equipo ganador/perdedor.
const ELO_K = 32
const ELO_BASE = 1000
const MIN_GAMES = 5 // menos de esto = en colocación (fuera del ladder)
// legado: solo como respaldo para historiales viejos sin delta Elo
const WIN_PTS = 20
const LOSS_PTS = 20
const rhalf = (x) => (x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5))
const eloExpected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400))
// MMR del jugador; si falta la columna se aproxima desde puntos legacy (base 0 -> escala 600)
const getMmr = (p) => p.mmr ?? (p.points != null ? p.points + 600 : ELO_BASE)
// puntos_rango = lo único que se muestra (MMR inicial 1000 = Bronce IV 0 LP)
const getPuntos = (p) => getMmr(p) - 600

// Divisiones de 100 LP (0-99), 4 por tier (400 pts). Maestro sin divisiones.
const ELO_TIERS = ['Hierro', 'Bronce', 'Plata', 'Oro', 'Platino', 'Esmeralda', 'Diamante']
const getRank = (puntos) => {
  if (puntos >= 2800) return { name: 'Maestro', div: null, lp: null }
  return {
    name: ELO_TIERS[Math.floor(puntos / 400)],
    div: ['IV', 'III', 'II', 'I'][Math.floor((puntos % 400) / 100)],
    lp: puntos % 100,
  }
}
const rankLabel = (r) => (r.lp === null || r.lp === undefined ? r.name : `${r.name} ${r.div} - ${r.lp} LP`)
const rankShort = (r) => (r.div ? `${r.name} ${r.div}` : r.name)
const getGames = (p) => (p.wins ?? 0) + (p.losses ?? 0)
const getLosses = (p) => p.losses ?? 0
const getStreak = (p) => p.streak ?? 0
const getPentas = (p) => p.pentakills ?? 0
const FIRE_STREAK = 2 // racha mínima para mostrar fuego
const isPlaced = (p) => getGames(p) >= MIN_GAMES
const getWrOrNeg = (p) => {
  const t = getGames(p)
  return t ? (p.wins ?? 0) / t : -1
}

const SQL_PLAYERS = `create table if not exists players (
  id bigint generated always as identity primary key,
  name text not null,
  wins int default 0,
  losses int default 0,
  points int default 0,
  streak int default 0,
  pentakills int default 0,
  mmr int default 1000,
  avatar text,
  created_at timestamptz default now()
);
alter table players enable row level security;
drop policy if exists "demo" on players;
create policy "demo" on players for all using (true) with check (true);
-- si tu tabla ya existe, corre esto para migrar a Elo (MMR oculto base 1000):
-- alter table players add column if not exists losses int default 0;
-- alter table players add column if not exists points int default 0;
-- alter table players add column if not exists streak int default 0;
-- alter table players add column if not exists pentakills int default 0;
-- alter table players add column if not exists avatar text;
-- alter table players add column if not exists mmr int default 1000;
-- update players set points = mmr - 600 where mmr is not null;
-- evita duplicados del mismo nombre (recomendado):
-- create unique index if not exists players_name_lower_uidx on players (lower(name));
-- realtime para ver cambios al instante en todos los dispositivos (opcional):
-- alter publication supabase_realtime add table players;`

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

  // trae el ranking real de la DB y deja activeIds sin fantasmas
  // (ids que ya no existen porque se borraron en otro dispositivo o en el dashboard)
  const fetchFreshPlayers = async () => {
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) throw error
    const fresh = data ?? []
    setAllPlayers(fresh)
    const valid = new Set(fresh.map((p) => p.id))
    setActiveIds((prev) => {
      try {
        const saved =
          prev.length > 0
            ? prev
            : JSON.parse(localStorage.getItem(LS_ACTIVE) ?? 'null') ?? fresh.map((p) => p.id)
        const cleaned = saved.filter((id) => valid.has(id))
        // si no había nada guardado (primera vez), todos activos
        if (prev.length === 0 && !localStorage.getItem(LS_ACTIVE)) return fresh.map((p) => p.id)
        return cleaned
      } catch {
        return fresh.map((p) => p.id)
      }
    })
    return fresh
  }

  // cargar ranking + mantenerlo sincronizado (dashboard / otro dispositivo)
  useEffect(() => {
    const load = async () => {
      if (isSupabaseConfigured) {
        try {
          await fetchFreshPlayers()
        } catch (error) {
          setStatus('Crea la tabla players con el SQL de abajo: ' + error.message)
        }
      } else {
        try {
          const raw = localStorage.getItem(LS_PLAYERS)
          if (raw) {
            const list = JSON.parse(raw)
            setAllPlayers(list)
            const savedActive = localStorage.getItem(LS_ACTIVE)
            if (savedActive) {
              const valid = new Set(list.map((p) => p.id))
              setActiveIds(JSON.parse(savedActive).filter((id) => valid.has(id)))
            } else setActiveIds(list.map((p) => p.id))
          }
        } catch {}
      }
    }
    load()

    if (!isSupabaseConfigured) return
    // revalida al volver a la pestaña (por si se borró en el dashboard)
    const onFocus = () => {
      fetchFreshPlayers().catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    // realtime si está habilitado en Supabase (best-effort, no rompe si no lo está)
    let channel = null
    try {
      channel = supabase
        .channel('players-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, () => {
          fetchFreshPlayers().catch(() => {})
        })
        .subscribe()
    } catch {}
    return () => {
      window.removeEventListener('focus', onFocus)
      if (channel) supabase.removeChannel(channel).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setStatus('')
    // revalida contra la DB: el estado local puede estar desactualizado
    // (ej. se borró en el dashboard u otro dispositivo) y bloquearía recrear
    let list = allPlayers
    if (isSupabaseConfigured) {
      try {
        list = await fetchFreshPlayers()
      } catch (err) {
        setStatus(err.message)
        return
      }
    }
    const currentActive = isSupabaseConfigured
      ? (() => {
          try {
            const raw = localStorage.getItem(LS_ACTIVE)
            if (raw == null) return list.map((p) => p.id)
            return JSON.parse(raw).filter((id) => list.some((p) => p.id === id))
          } catch {
            return list.map((p) => p.id)
          }
        })()
      : activeIds
    const existing = list.find((p) => p.name.toLowerCase() === clean.toLowerCase())
    if (existing) {
      if (!currentActive.includes(existing.id)) {
        if (currentActive.length >= MAX_TOTAL) {
          setStatus(`Partido lleno: máximo ${MAX_TOTAL} (5v5)`)
          return
        }
        const next = [...currentActive, existing.id]
        setActiveIds(next)
      }
      setStatus(`"${existing.name}" ya estaba en ranking, entró al partido.`)
      setName('')
      return
    }
    if (currentActive.length >= MAX_TOTAL) {
      setStatus(`Máximo ${MAX_TOTAL} jugadores en partido (5 vs 5)`)
      return
    }
    if (isSupabaseConfigured) {
      const rankedPayload = { name: clean, wins: 0, losses: 0, points: 400, streak: 0, pentakills: 0, mmr: 1000 }
      let { data, error } = await supabase.from('players').insert(rankedPayload).select()
      if (error && isSchemaCacheError(error)) {
        // tabla sin migrar a ranked: reintenta con columnas básicas
        ;({ data, error } = await supabase.from('players').insert({ name: clean, wins: 0 }).select())
      }
      if (error) {
        // si otro dispositivo lo creó a la vez (unique), revalida y reactiva
        if (error.code === '23505') {
          try {
            const fresh = await fetchFreshPlayers()
            const dup = fresh.find((p) => p.name.toLowerCase() === clean.toLowerCase())
            if (dup) {
              setActiveIds((prev) => (prev.includes(dup.id) ? prev : [...prev, dup.id]))
              setStatus(`"${dup.name}" ya estaba en ranking, entró al partido.`)
              setName('')
              return
            }
          } catch {}
        }
        setStatus(error.message)
      } else if (data && data[0]) {
        setAllPlayers((prev) => [...prev, data[0]])
        setActiveIds((prev) => [...prev, data[0].id])
      }
    } else {
      const np = { id: uid(), name: clean, wins: 0, losses: 0, points: 400, streak: 0, pentakills: 0, mmr: 1000 }
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
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('players').delete().eq('id', id)
      if (error) {
        setStatus(error.message)
        return
      }
      // revalida desde la DB: así el nombre queda libre para recrearlo
      try {
        await fetchFreshPlayers()
      } catch (err) {
        setStatus(err.message)
      }
      removeFromMatchSilent(id)
    } else {
      removeFromMatchSilent(id)
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

  // Elo: cambio según promedio de cada equipo, igual para todo el equipo
  const registerWin = async (winner) => {
    if (!requireAdmin()) return
    const winners = winner === 'A' ? teamA : teamB
    const losers = winner === 'A' ? teamB : teamA
    if (winners.length === 0) return
    const avgW = winners.reduce((a, p) => a + getMmr(p), 0) / winners.length
    const avgL = losers.length
      ? losers.reduce((a, p) => a + getMmr(p), 0) / losers.length
      : avgW
    const expW = eloExpected(avgW, avgL)
    const deltaW = rhalf(ELO_K * (1 - expW))
    const deltaL = rhalf(ELO_K * (0 - (1 - expW)))
    const mmrW = (p) => Math.max(0, getMmr(p) + deltaW)
    const mmrL = (p) => Math.max(0, getMmr(p) + deltaL)
    setLastWinner(winner)
    const entry = {
      key: uid() + Date.now().toString(36),
      winner,
      ids: winners.map((p) => p.id),
      loserIds: losers.map((p) => p.id),
      names: winners.map((p) => p.name),
      loserNames: losers.map((p) => p.name),
      prevStreaks: Object.fromEntries(allPlayers.map((p) => [p.id, getStreak(p)])),
      deltaW,
      deltaL,
      at: new Date().toISOString(),
    }
    const applyRanked = (list) =>
      list.map((p) => {
        if (entry.ids.includes(p.id))
          return { ...p, wins: (p.wins ?? 0) + 1, mmr: mmrW(p), points: mmrW(p) - 600, streak: getStreak(p) + 1 }
        if (entry.loserIds.includes(p.id))
          return { ...p, losses: getLosses(p) + 1, mmr: mmrL(p), points: mmrL(p) - 600, streak: 0 }
        return p
      })
    if (isSupabaseConfigured) {
      for (const p of winners) {
        const next = mmrW(p)
        const { error } = await safeUpdate(
          p.id,
          { wins: (p.wins ?? 0) + 1, mmr: next, points: next - 600, streak: getStreak(p) + 1 },
          { wins: (p.wins ?? 0) + 1 }
        )
        if (error && !isSchemaCacheError(error)) setStatus(error.message)
      }
      for (const p of losers) {
        const next = mmrL(p)
        const { error } = await safeUpdate(
          p.id,
          { losses: getLosses(p) + 1, mmr: next, points: next - 600, streak: 0 },
          {} // sin columnas ranked no hay nada que restar al perdedor
        )
        if (error && !isSchemaCacheError(error)) setStatus(error.message)
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

  // deshace un registro erróneo: revierte el delta Elo exacto aplicado al registrar
  const undoWin = async (entry) => {
    if (!requireAdmin()) return
    const idSet = new Set(entry.ids)
    const loserSet = new Set(entry.loserIds ?? [])
    const prev = entry.prevStreaks ?? {}
    const restoreStreak = (p) => (prev[p.id] ?? Math.max(0, getStreak(p) - (idSet.has(p.id) ? 1 : 0)))
    const hasElo = entry.deltaW !== undefined && entry.deltaL !== undefined
    if (isSupabaseConfigured) {
      for (const p of allPlayers.filter((p) => idSet.has(p.id))) {
        const nextMmr = hasElo ? Math.max(0, getMmr(p) - entry.deltaW) : Math.max(0, getPuntos(p) - 20) + 600
        const { error } = await safeUpdate(
          p.id,
          { wins: Math.max(0, (p.wins ?? 0) - 1), mmr: nextMmr, points: nextMmr - 600, streak: restoreStreak(p) },
          { wins: Math.max(0, (p.wins ?? 0) - 1) }
        )
        if (error && !isSchemaCacheError(error)) setStatus(error.message)
      }
      for (const p of allPlayers.filter((p) => loserSet.has(p.id))) {
        const nextMmr = hasElo ? getMmr(p) - entry.deltaL : getPuntos(p) + 20 + 600
        const { error } = await safeUpdate(
          p.id,
          { losses: Math.max(0, getLosses(p) - 1), mmr: nextMmr, points: nextMmr - 600, streak: restoreStreak(p) },
          {}
        )
        if (error && !isSchemaCacheError(error)) setStatus(error.message)
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
        if (idSet.has(p.id)) {
          const m = hasElo ? Math.max(0, getMmr(p) - entry.deltaW) : Math.max(0, getPuntos(p) - 20) + 600
          return { ...p, wins: Math.max(0, (p.wins ?? 0) - 1), mmr: m, points: m - 600, streak: restoreStreak(p) }
        }
        if (loserSet.has(p.id)) {
          const m = hasElo ? getMmr(p) - entry.deltaL : getPuntos(p) + 20 + 600
          return { ...p, losses: Math.max(0, getLosses(p) - 1), mmr: m, points: m - 600, streak: restoreStreak(p) }
        }
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

  // fila del ranking (ladder y colocación comparten diseño)
  const rankRow = (p, posLabel, i, unplaced) => {
    const pts = getPuntos(p)
    const r = getRank(pts)
    const w = p.wins ?? 0
    const l = getLosses(p)
    const st = getStreak(p)
    const pe = getPentas(p)
    const total = w + l
    const wr = total ? Math.round((w / total) * 100) : 0
    const onFire = st >= FIRE_STREAK
    const posClass = !unplaced && i < 3 ? `pos-${i + 1}` : ''
    return (
      <div
        key={p.id}
        className={`m3-list-row rank-card rank-in ${!unplaced && i === 0 ? 'top' : ''} ${onFire ? 'on-fire' : ''}`}
        style={{ animationDelay: `${Math.min(i, 10) * 0.05}s` }}
      >
        <span className={`m3-pos ${posClass}`} title={unplaced ? 'En colocación' : `Puesto ${posLabel}`}>{posLabel}</span>
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
          {unplaced ? (
            <span className="m3-rank-line">En colocación • {total}/{MIN_GAMES}</span>
          ) : (
            <span className="m3-rank-line">{rankLabel(r)}</span>
          )}
          <span className="m3-stats">
            <span className="stat stat-win" title={`${w} victorias`}>{w}W</span>
            <span className="stat stat-loss" title={`${l} derrotas`}>{l}L</span>
            <span className="stat stat-wr" title={total ? `Winrate ${wr}% en ${total} partidas` : 'Sin partidas registradas'}>{total ? `WR ${wr}%` : 'WR —'}</span>
          </span>
        </span>
        <span className="m3-wins-badge" title={unplaced ? 'Sin rango oficial' : rankLabel(r)}>
          <span className="material-symbols-rounded">military_tech</span>
          {unplaced ? `${total}/${MIN_GAMES}` : rankShort(r)}
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
  }

  // ladder: solo colocados (5+ partidas), por puntos → winrate → partidas.
  // Los de colocación van abajo en sección aparte (como en LoL).
  const ranking = allPlayers
    .filter(isPlaced)
    .sort((a, b) => getPuntos(b) - getPuntos(a) || getWrOrNeg(b) - getWrOrNeg(a) || getGames(b) - getGames(a))
  const placement = allPlayers
    .filter((p) => !isPlaced(p))
    .sort((a, b) => getGames(b) - getGames(a) || getPuntos(b) - getPuntos(a))
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
                {rankShort(getRank(getPuntos(p)))}
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
                  {p.name} ({rankShort(getRank(getPuntos(p)))})
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
              +{winHistory[0].deltaW ?? WIN_PTS} LP para: {(lastWinner === 'A' ? teamA : teamB).map((p) => p.name).join(', ')}<br />
              {winHistory[0].deltaL ?? -LOSS_PTS} LP para: {(lastWinner === 'A' ? teamB : teamA).map((p) => p.name).join(', ') || '—'}
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
                    Equipo {h.winner} +{h.deltaW ?? WIN_PTS}/−{-(h.deltaL ?? -LOSS_PTS)} ({h.names.join(', ')})
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
          {isSupabaseConfigured && (
            <button
              onClick={() => fetchFreshPlayers().catch((err) => setStatus(err.message))}
              className="m3-btn m3-btn-outlined"
              style={{ height: 36, padding: '0 12px', marginLeft: 'auto' }}
              title="Recargar desde la base de datos"
            >
              <span className="material-symbols-rounded">refresh</span>
            </button>
          )}
        </div>
        <p className="m3-support">Se conserva aunque salgan del partido. Sistema Elo: el cambio depende del nivel de cada equipo. Solo admin puede borrar definitivo.</p>
        {ranking.length === 0 && placement.length === 0 ? (
          <p className="m3-muted">Sin datos aún.</p>
        ) : (
          <>
            <div className="m3-list rank-list">
              {ranking.map((p, i) => rankRow(p, String(i + 1), i, false))}
            </div>
            {placement.length > 0 && (
              <>
                <p className="m3-support" style={{ marginTop: 14 }}>
                  En colocación (juega {MIN_GAMES} partidas para entrar al ladder):
                </p>
                <div className="m3-list rank-list">
                  {placement.map((p, i) => rankRow(p, '·', i, true))}
                </div>
              </>
            )}
          </>
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
