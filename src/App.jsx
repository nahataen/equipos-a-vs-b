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

// LP por racha (esté estilo LoL simplificado):
// base: gana +40 / pierde −20. Racha de 3+ victorias seguidas: gana +50.
// Perder con racha de 3+ victorias (rompe la racha): solo −15.
// Racha de 3+ derrotas seguidas: −25 (castigo). Tras romper racha vuelve el base.
const LP_WIN = 40
const LP_WIN_HOT = 50
const LP_LOSS = 20
const LP_LOSS_MERCY = 15
const LP_LOSS_COLD = 25
const HOT_STREAK = 3
const COLD_STREAK = 3
const nextStreakOnWin = (s) => (s > 0 ? s + 1 : 1)
const nextStreakOnLoss = (s) => (s < 0 ? s - 1 : -1)
const lpForWin = (streakBefore) => (nextStreakOnWin(streakBefore) >= HOT_STREAK ? LP_WIN_HOT : LP_WIN)
const lpForLoss = (streakBefore) =>
  streakBefore >= HOT_STREAK
    ? LP_LOSS_MERCY
    : Math.abs(nextStreakOnLoss(streakBefore)) >= COLD_STREAK
      ? LP_LOSS_COLD
      : LP_LOSS
const MIN_GAMES = 5 // menos de esto = en colocación (fuera del ladder)
// legado: solo como respaldo para historiales viejos sin deltas guardados
const WIN_PTS = 40
const LOSS_PTS = 20
const ELO_BASE = 800
// MMR del jugador; si falta la columna se aproxima desde puntos legacy (base 0 -> escala 600)
const getMmr = (p) => p.mmr ?? (p.points != null ? p.points + 600 : ELO_BASE)
// puntos_rango = lo único que se muestra (MMR inicial 800 = Bronce IV 0 LP)
const getPuntos = (p) => getMmr(p) - 600

// 5 tiers × 200pts c/u (divisiones de 50LP). Maestro desde 1000pts.
const ELO_TIERS = ['Hierro', 'Bronce', 'Plata', 'Oro', 'Diamante']
const getRank = (puntos) => {
  if (puntos >= 1000) return { name: 'Maestro', div: null, lp: null }
  const idx = Math.min(Math.floor(puntos / 200), ELO_TIERS.length - 1)
  return {
    name: ELO_TIERS[idx],
    div: ['IV', 'III', 'II', 'I'][Math.floor((puntos % 200) / 50)],
    lp: puntos % 50,
  }
}
const rankLabel = (r) => (r.lp === null || r.lp === undefined ? r.name : `${r.name} ${r.div} - ${r.lp} LP`)
const rankShort = (r) => (r.div ? `${r.name} ${r.div}` : r.name)
const getGames = (p) => (p.wins ?? 0) + (p.losses ?? 0)
const getLosses = (p) => p.losses ?? 0
const getStreak = (p) => p.streak ?? 0
const getPentas = (p) => p.pentakills ?? 0
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
-- si tu tabla ya existe, corre esto para migrar al sistema ranked:
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

  // Esc cierra la vista previa, el login y la ayuda
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPreview(null)
        setShowLogin(false)
        setShowHelp(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // admin
  const [isAdmin, setIsAdmin] = useState(() => sessionStorage.getItem(LS_ADMIN) === '1')
  const [pw, setPw] = useState('')
  const [showLogin, setShowLogin] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
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
      const rankedPayload = { name: clean, wins: 0, losses: 0, points: 200, streak: 0, pentakills: 0, mmr: 800 }
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
      const np = { id: uid(), name: clean, wins: 0, losses: 0, points: 200, streak: 0, pentakills: 0, mmr: 800 }
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

  // BALANCEADO POR NIVEL (serpiente por MMR: 1A 2B 3B 4A 5A... parejas alternadas)
  const assignBalanced = () => {
    if (!requireAdmin()) return
    if (activePlayers.length < 2) {
      setStatus('Agrega al menos 2 jugadores al partido (1v1 mínimo)')
      return
    }
    setStatus('')
    setLastWinner(null)
    const sorted = [...activePlayers].sort((a, b) => getMmr(b) - getMmr(a))
    const A = [], B = []
    sorted.forEach((p, idx) => {
      const pairEven = Math.floor(idx / 2) % 2 === 0
      const first = idx % 2 === 0
      const toA = pairEven ? first : !first
      ;(toA ? A : B).push(p)
    })
    setTeamA(A)
    setTeamB(B)
    const avg = (t) => Math.round(t.reduce((a, p) => a + getPuntos(p), 0) / t.length)
    setStatus(`Nivel parejo: A ~${avg(A)} pts vs B ~${avg(B)} pts`) 
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

  // LP por racha: cada jugador gana/pierde según su propia racha actual
  const registerWin = async (winner) => {
    if (!requireAdmin()) return
    const winners = winner === 'A' ? teamA : teamB
    const losers = winner === 'A' ? teamB : teamA
    if (winners.length === 0) return
    setLastWinner(winner)
    const deltas = {}
    for (const p of winners) deltas[p.id] = lpForWin(getStreak(p))
    for (const p of losers) deltas[p.id] = -lpForLoss(getStreak(p))
    const entry = {
      key: uid() + Date.now().toString(36),
      winner,
      ids: winners.map((p) => p.id),
      loserIds: losers.map((p) => p.id),
      names: winners.map((p) => p.name),
      loserNames: losers.map((p) => p.name),
      prevStreaks: Object.fromEntries(allPlayers.map((p) => [p.id, getStreak(p)])),
      deltas,
      // legado para deshacer de historiales viejos (Elo de la versión anterior)
      deltaW: winners.length ? Math.max(...winners.map((p) => deltas[p.id])) : LP_WIN,
      deltaL: losers.length ? Math.min(...losers.map((p) => deltas[p.id])) : -LP_LOSS,
      at: new Date().toISOString(),
    }
    const nextMmrOf = (p, d) => Math.max(0, getMmr(p) + d)
    const applyRanked = (list) =>
      list.map((p) => {
        if (entry.ids.includes(p.id)) {
          const m = nextMmrOf(p, deltas[p.id])
          return { ...p, wins: (p.wins ?? 0) + 1, mmr: m, points: m - 600, streak: nextStreakOnWin(getStreak(p)) }
        }
        if (entry.loserIds.includes(p.id)) {
          const m = nextMmrOf(p, deltas[p.id])
          return { ...p, losses: getLosses(p) + 1, mmr: m, points: m - 600, streak: nextStreakOnLoss(getStreak(p)) }
        }
        return p
      })
    if (isSupabaseConfigured) {
      for (const p of winners) {
        const next = nextMmrOf(p, deltas[p.id])
        const { error } = await safeUpdate(
          p.id,
          { wins: (p.wins ?? 0) + 1, mmr: next, points: next - 600, streak: nextStreakOnWin(getStreak(p)) },
          { wins: (p.wins ?? 0) + 1 }
        )
        if (error && !isSchemaCacheError(error)) setStatus(error.message)
      }
      for (const p of losers) {
        const next = nextMmrOf(p, deltas[p.id])
        const { error } = await safeUpdate(
          p.id,
          { losses: getLosses(p) + 1, mmr: next, points: next - 600, streak: nextStreakOnLoss(getStreak(p)) },
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

  // deshace un registro erróneo: revierte el delta exacto aplicado al registrar
  const undoWin = async (entry) => {
    if (!requireAdmin()) return
    const idSet = new Set(entry.ids)
    const loserSet = new Set(entry.loserIds ?? [])
    const prev = entry.prevStreaks ?? {}
    const restoreStreak = (p) => (prev[p.id] ?? Math.max(0, getStreak(p) - (idSet.has(p.id) ? 1 : 0)))
    // delta por jugador guardado al registrar; historiales viejos usan deltaW/deltaL
    const dOf = (p, fallback) => (entry.deltas?.[p.id] ?? fallback)
    const hasElo = entry.deltaW !== undefined && entry.deltaL !== undefined
    const backMmr = (p, d) => Math.max(0, getMmr(p) - d)
    if (isSupabaseConfigured) {
      for (const p of allPlayers.filter((p) => idSet.has(p.id))) {
        const fallback = hasElo ? entry.deltaW : 30
        const nextMmr = backMmr(p, dOf(p, fallback))
        const { error } = await safeUpdate(
          p.id,
          { wins: Math.max(0, (p.wins ?? 0) - 1), mmr: nextMmr, points: nextMmr - 600, streak: restoreStreak(p) },
          { wins: Math.max(0, (p.wins ?? 0) - 1) }
        )
        if (error && !isSchemaCacheError(error)) setStatus(error.message)
      }
      for (const p of allPlayers.filter((p) => loserSet.has(p.id))) {
        const fallback = hasElo ? entry.deltaL : -15
        const nextMmr = backMmr(p, dOf(p, fallback))
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
          const fallback = hasElo ? entry.deltaW : 30
          const m = backMmr(p, dOf(p, fallback))
          return { ...p, wins: Math.max(0, (p.wins ?? 0) - 1), mmr: m, points: m - 600, streak: restoreStreak(p) }
        }
        if (loserSet.has(p.id)) {
          const fallback = hasElo ? entry.deltaL : -15
          const m = backMmr(p, dOf(p, fallback))
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
    const onFire = st >= HOT_STREAK
    const onCold = st <= -COLD_STREAK
    const posClass = !unplaced && i < 3 ? `pos-${i + 1}` : ''
    const tierClass = unplaced ? '' : `tier-${r.name.toLowerCase()}`
    return (
      <div
        key={p.id}
        className={`m3-list-row rank-card rank-in ${tierClass} ${!unplaced && i === 0 ? 'top' : ''} ${onFire ? 'on-fire' : ''} ${onCold ? 'on-cold' : ''}`}
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
            <span className="m3-fire" title={`Racha de ${st} victorias • gana +${LP_WIN_HOT} LP`}>
              <span className="material-symbols-rounded">local_fire_department</span>
              x{st}
            </span>
          )}
          {onCold && (
            <span className="m3-cold" title={`Racha de ${-st} derrotas • pierde −${LP_LOSS_COLD} LP`}>
              <span className="material-symbols-rounded">ac_unit</span>
              x{-st}
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
        <button onClick={() => setShowHelp(true)} className="m3-btn m3-btn-outlined" title="Cómo funciona el ranking">
          <span className="material-symbols-rounded">help</span>
          <span className="m3-btn-label">Ayuda</span>
        </button>
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

      {showHelp && (
        <div className="m3-lightbox" onClick={() => setShowHelp(false)}>
          <div className="m3-lightbox-card m3-help-card" onClick={(e) => e.stopPropagation()}>
            <h2><span className="material-symbols-rounded">emoji_events</span> Cómo funciona el ranking</h2>
            <div className="m3-help-body">
              <h3>Tu puntaje secreto</h3>
              <p>Todos empiezan en <b>Bronce IV - 0 LP</b>. Ganar suma LP y perder los quita. Con 5+ partidas entras al ladder oficial.</p>
              <h3>Cuánto subes o bajas por partida</h3>
              <table className="m3-help-table">
                <thead><tr><th>Situación</th><th>Ganar</th><th>Perder</th></tr></thead>
                <tbody>
                  <tr><td>Normal (o tras romper una racha)</td><td className="w">+40</td><td className="l">−20</td></tr>
                  <tr><td>Racha de 3+ victorias seguidas 🔥</td><td className="w">+50</td><td>−15 (solo la que rompe la racha)</td></tr>
                  <tr><td>Racha de 3+ derrotas seguidas ❄️</td><td className="w">+40</td><td className="l">−25</td></tr>
                </tbody>
              </table>
              <p>Si ganas <b>3 seguidas</b> empiezas a ganar más (+50) y perder cuesta menos (−15). Si pierdes tras la racha, vuelves al base: +40 / −20. Si caes en <b>3 derrotas seguidas</b> te castigan más (−25).</p>
              <h3>Lo que ves: rango y LP</h3>
              <p>Empiezas en <b>Bronce IV - 0 LP</b>. Cada división vale <b>50 LP</b> y cada tier tiene 4 divisiones (de la IV a la I).</p>
              <table className="m3-help-table">
                <thead><tr><th>Tier</th><th>Puntos</th><th>Divisiones</th></tr></thead>
                <tbody>
                  <tr><td>Hierro</td><td>0 – 199</td><td>IV III II I (50LP c/u)</td></tr>
                  <tr><td>Bronce</td><td>200 – 399</td><td>IV III II I (50LP c/u)</td></tr>
                  <tr><td>Plata</td><td>400 – 599</td><td>IV III II I (50LP c/u)</td></tr>
                  <tr><td>Oro</td><td>600 – 799</td><td>IV III II I (50LP c/u)</td></tr>
                  <tr><td>Diamante</td><td>800 – 999</td><td>IV III II I (50LP c/u)</td></tr>
                  <tr><td>Maestro</td><td>1000+</td><td>sin divisiones</td></tr>
                </tbody>
              </table>
              <h3>Rachas: el fuego y el frío</h3>
              <p>🔥 <b>3 victorias seguidas</b> = bonus: ganas +50 y perder solo cuesta −15 (la que rompe la racha). Después vuelves al base.</p>
              <p>❄️ <b>3 derrotas seguidas</b> = castigo: pierdes −25. Con la primera victoria vuelves al base.</p>
              <h3>Equipos por partida</h3>
              <p>Quién jugó de cada lado, con el promedio del equipo y lo que subió o bajó cada uno:</p>
              <div className="m3-help-scroll">
              <table className="m3-help-table">
                <thead><tr><th>#</th><th>Ganadores (prom.)</th><th>Perdedores (prom.)</th><th>Cambio</th></tr></thead>
                <tbody>
                  <tr><td>P1</td><td>Nata, Roxas, DJ, Poppa, Hanubi (400)</td><td>Neid, Junko, Blubby, Hanz, Mika (400)</td><td>+30 / −15</td></tr>
                  <tr><td>P2</td><td>DJ, Hanubi, Neid, Blubby, Poppa (412)</td><td>Nata, Junko, Hanz, Mika, Roxas (403)</td><td>+30 / −12/−15</td></tr>
                  <tr><td>P3</td><td>Nata, Hanubi, Neid, Blubby, Junko (416)</td><td>Mika, Roxas, Hanz, DJ, Poppa (416)</td><td>+30/+35 / −12/−15/−20</td></tr>
                  <tr><td>P4</td><td>Hanubi, Blubby, DJ, Mika, Fairy (428)</td><td>Nata, Roxas, Hanz, Junko, Neid (409)</td><td>+30/+35 / −12/−20</td></tr>
                  <tr><td>P5</td><td>Nata, Hanz, Junko, Neid, DJ (413)</td><td>Hanubi, Blubby, Mika, Fairy, Roxas (441)</td><td>+30 / −12/−20</td></tr>
                  <tr><td>P6</td><td>Blubby, Mika, Junko, DJ, Hanz (424)</td><td>Nata, Roxas, Neid, Hanubi, Fairy (446)</td><td>+30/+35 / −12/−15/−20</td></tr>
                  <tr><td>P7</td><td>Blubby, Junko, Roxas, Fairy, Neid (429)</td><td>Nata, Mika, DJ, Hanz, Hanubi (458)</td><td>+30/+35 / −12/−15/−20</td></tr>
                  <tr><td>P8</td><td>Junko, Roxas, Hanz, Mika, Hanubi (421)</td><td>Nata, DJ, Neid, Fairy, Blubby (482)</td><td>+30/+35 / −12/−20</td></tr>
                </tbody>
              </table>
              </div>
              <h3>Historial de partidas</h3>
              <p>Puntaje de cada jugador después de cada partida (<span style={{ color: '#5fd68b', fontWeight: 800 }}>verde = ganó</span>, <span style={{ color: 'var(--md-sys-color-error)', fontWeight: 800 }}>rojo = perdió</span>). Todos parten de 400:</p>
              <table className="m3-help-table m3-matrix">
                <thead><tr><th></th><th>Inicio</th><th>P1</th><th>P2</th><th>P3</th><th>P4</th><th>P5</th><th>P6</th><th>P7</th><th>P8</th><th>Total</th></tr></thead>
                <tbody>
                  <tr><td>Nataen</td><td className="start">400</td><td className="w">430</td><td className="l">418</td><td className="w">448</td><td className="l">436</td><td className="w">466</td><td className="l">454</td><td className="l">439</td><td className="l">419</td><td>3-5</td></tr>
                  <tr><td>Roxas</td><td className="start">400</td><td className="w">430</td><td className="l">418</td><td className="l">403</td><td className="l">383</td><td className="l">363</td><td className="l">343</td><td className="w">373</td><td className="w">403</td><td>3-5</td></tr>
                  <tr><td>DJuanchito</td><td className="start">400</td><td className="w">430</td><td className="w">460</td><td className="l">448</td><td className="w">478</td><td className="w">508</td><td className="w">543</td><td className="l">531</td><td className="l">516</td><td>5-3</td></tr>
                  <tr><td>Poppa</td><td className="start">400</td><td className="w">430</td><td className="w">460</td><td className="l">448</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>2-1</td></tr>
                  <tr><td>Hanubi</td><td className="start">400</td><td className="w">430</td><td className="w">460</td><td className="w">495</td><td className="w">530</td><td className="l">518</td><td className="l">503</td><td className="l">483</td><td className="w">513</td><td>5-3</td></tr>
                  <tr><td>Neid</td><td className="start">400</td><td className="l">385</td><td className="w">415</td><td className="w">445</td><td className="l">433</td><td className="w">463</td><td className="l">451</td><td className="w">481</td><td className="l">469</td><td>4-4</td></tr>
                  <tr><td>Junko</td><td className="start">400</td><td className="l">385</td><td className="l">370</td><td className="w">400</td><td className="l">388</td><td className="w">418</td><td className="w">448</td><td className="w">483</td><td className="w">518</td><td>5-3</td></tr>
                  <tr><td>Blubby</td><td className="start">400</td><td className="l">385</td><td className="w">415</td><td className="w">445</td><td className="w">480</td><td className="l">468</td><td className="w">498</td><td className="w">528</td><td className="l">516</td><td>5-3</td></tr>
                  <tr><td>Hanz</td><td className="start">400</td><td className="l">385</td><td className="l">370</td><td className="l">350</td><td className="l">330</td><td className="w">360</td><td className="w">390</td><td className="l">378</td><td className="w">408</td><td>3-5</td></tr>
                  <tr><td>Mika</td><td className="start">400</td><td className="l">385</td><td className="l">370</td><td className="l">350</td><td className="w">380</td><td className="l">368</td><td className="w">398</td><td className="l">386</td><td className="w">416</td><td>3-5</td></tr>
                  <tr><td>Fairy</td><td className="start">400</td><td>—</td><td>—</td><td>—</td><td className="w">430</td><td className="l">418</td><td className="l">403</td><td className="w">433</td><td className="l">421</td><td>2-3</td></tr>
                  <tr><td>Sanns</td><td className="start">400</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>0-0</td></tr>
                </tbody>
              </table>
              <h3>Colocación</h3>
              <p>Con menos de <b>5 partidas</b> no tienes rango: apareces abajo como <b>En colocación</b>. A la 5ª entras a la tabla.</p>
              <h3>Equipos</h3>
              <p><b>Random</b> para variar. <b>Balancear</b> para un partido parejo.</p>
            </div>
            <button onClick={() => setShowHelp(false)} className="m3-btn m3-btn-tonal">
              <span className="material-symbols-rounded">close</span>
              Cerrar
            </button>
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
          <button
            onClick={clearTeams}
            className="m3-btn m3-btn-outlined"
            style={{ height: 36, padding: '0 12px', marginLeft: 'auto' }}
            disabled={!isAdmin}
            title="Limpiar equipos"
          >
            <span className="material-symbols-rounded">restart_alt</span>
          </button>
        </div>
        <p className="m3-support">Mezcla solo a los del partido actual (máx 5 por lado).</p>
        <div className="m3-fab-row">
          <button onClick={assignRandom} disabled={spinning || activePlayers.length < 2 || !isAdmin} className="m3-btn m3-btn-filled" title={!isAdmin ? 'Solo admin' : ''}>
            <span className="material-symbols-rounded">{spinning ? 'progress_activity' : 'shuffle'}</span>
            {spinning ? 'Girando...' : 'Asignar equipos random'}
          </button>
          <button onClick={assignBalanced} disabled={spinning || activePlayers.length < 2 || !isAdmin} className="m3-btn m3-btn-tonal" title={isAdmin ? 'Reparte por nivel (MMR) para un partido parejo' : 'Solo admin'}>
            <span className="material-symbols-rounded">balance</span>
            Balancear por nivel
          </button>
        </div>
        <div className={`m3-teams ${spinning ? 'spinning' : ''}`}>
          <div className="m3-team a">
            <h3><span className="material-symbols-rounded">shield</span>Equipo A ({teamA.length}){teamA.length > 0 && ` · ${Math.round(teamA.reduce((s, p) => s + getPuntos(p), 0) / teamA.length)} pts`}</h3>
            {teamA.map((p) => (
              <div key={p.id} className="m3-player">
                {p.avatar ? <img className="m3-player-avatar" src={p.avatar} alt={p.name} /> : <span className="material-symbols-rounded">person</span>}
                {p.name}
              </div>
            ))}
            {teamA.length === 0 && <span className="m3-muted">—</span>}
          </div>
          <div className="m3-vs">VS</div>
          <div className="m3-team b">
            <h3><span className="material-symbols-rounded">shield</span>Equipo B ({teamB.length}){teamB.length > 0 && ` · ${Math.round(teamB.reduce((s, p) => s + getPuntos(p), 0) / teamB.length)} pts`}</h3>
            {teamB.map((p) => (
              <div key={p.id} className="m3-player">
                {p.avatar ? <img className="m3-player-avatar" src={p.avatar} alt={p.name} /> : <span className="material-symbols-rounded">person</span>}
                {p.name}
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
              {(() => {
                const fmt = (arr, fallback) => {
                  const vals = [...new Set(arr.map((p) => winHistory[0].deltas?.[p.id] ?? fallback))]
                  return vals.map((v) => `${v > 0 ? '+' : ''}${v}`).join('/')
                }
                const winners = lastWinner === 'A' ? teamA : teamB
                const losers = lastWinner === 'A' ? teamB : teamA
                return (
                  <>
                    {fmt(winners, LP_WIN)} LP para: {winners.map((p) => p.name).join(', ')}<br />
                    {fmt(losers, -LP_LOSS)} LP para: {losers.map((p) => p.name).join(', ') || '—'}
                  </>
                )
              })()}
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
                    Equipo {h.winner} {h.deltas
                      ? [...new Set(h.ids.map((id) => h.deltas[id]))].map((v) => `${v > 0 ? '+' : ''}${v}`).join('/')
                      : `+${h.deltaW ?? WIN_PTS}/−${-(h.deltaL ?? -LOSS_PTS)}`} ({h.names.join(', ')})
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
        <p className="m3-support">Se conserva aunque salgan del partido. Gana +40, pierde −20 (rachas: +50 / −15 / −25). Solo admin puede borrar definitivo.</p>
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
