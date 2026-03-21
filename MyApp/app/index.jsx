import {
  StyleSheet, Text, View, Pressable,
  StatusBar, Animated, Alert, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useState, useRef, useEffect } from 'react'
import { CameraView, useCameraPermissions } from 'expo-camera'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL
const QUEUE_KEY    = 'upload_queue'   // AsyncStorage key — stores [{uri, filename}]
const NAME_KEY     = 'user_name'      // AsyncStorage key — stores the entered name
const USED_IDS_KEY = 'used_ids'       // AsyncStorage key — stores Set of used numbers per name
const ZOOM_LEVELS = [
  { label: '1x', value: 0 },
  { label: '2x', value: 0.5 },
]

// ── Unique filename generator ───────────────────────────────────────
// Generates name_XXXXXX where XXXXXX is a 6-digit number never used before by this name
const generateFilename = async (name) => {
  const raw = await AsyncStorage.getItem(USED_IDS_KEY)
  const usedIds = raw ? new Set(JSON.parse(raw)) : new Set()

  let num
  do {
    num = Math.floor(100000 + Math.random() * 900000) // always 6 digits
  } while (usedIds.has(num))

  usedIds.add(num)
  await AsyncStorage.setItem(USED_IDS_KEY, JSON.stringify([...usedIds]))

  const safeName = name.trim().toLowerCase().replace(/\s+/g, '_')
  return `${safeName}_${num}`
}

export default function Home() {
  const [permission, requestPermission] = useCameraPermissions()
  const [facing, setFacing]             = useState('back')
  const [activeZoom, setActiveZoom]     = useState('1x')
  const [zoom, setZoom]                 = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [userName, setUserName]         = useState(null)   // null = not loaded yet
  const [nameInput, setNameInput]       = useState('')     // text field value

  const cameraRef   = useRef(null)
  const busy        = useRef(false)
  const uploadQueue = useRef([])    // [{uri, filename}] — synced with AsyncStorage
  const processing  = useRef(false)

  // ── Animations ─────────────────────────────────────────────────────
  const flashOpacity    = useRef(new Animated.Value(0)).current
  const shutterScale    = useRef(new Animated.Value(1)).current
  const controlsOpacity = useRef(new Animated.Value(0)).current
  const controlsY       = useRef(new Animated.Value(60)).current

  // ── On App Open ────────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(NAME_KEY).then(saved => {
      setUserName(saved || '')  // '' means no name yet, triggers name screen
    })
  }, [])

  useEffect(() => {
    if (!userName) return  // wait until name is set

    loadSavedQueue()

    const unsubscribe = NetInfo.addEventListener(state => {
      if (state.isConnected) processNextInQueue()
    })

    Animated.parallel([
      Animated.timing(controlsOpacity, { toValue: 1, duration: 500, useNativeDriver: true, delay: 200 }),
      Animated.timing(controlsY,       { toValue: 0, duration: 500, useNativeDriver: true, delay: 200 }),
    ]).start()

    return () => unsubscribe()
  }, [userName])

  // ── Name Submit ────────────────────────────────────────────────────
  const handleNameSubmit = async () => {
    const trimmed = nameInput.trim()
    if (!trimmed) return
    await AsyncStorage.setItem(NAME_KEY, trimmed)
    setUserName(trimmed)
  }

  // ── AsyncStorage Helpers ───────────────────────────────────────────
  const loadSavedQueue = async () => {
    try {
      const saved = await AsyncStorage.getItem(QUEUE_KEY)
      if (saved) {
        const items = JSON.parse(saved)
        if (items.length > 0) {
          uploadQueue.current = items
          setPendingCount(items.length)
          processNextInQueue()
        }
      }
    } catch (e) {
      console.error('[queue load error]', e)
    }
  }

  const saveQueue = async (items) => {
    try {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items))
    } catch (e) {
      console.error('[queue save error]', e)
    }
  }

  // ── Queue Processor ────────────────────────────────────────────────
  const processNextInQueue = async () => {
    if (processing.current || uploadQueue.current.length === 0) return

    const net = await NetInfo.fetch()
    if (!net.isConnected) return

    processing.current = true
    const { uri, filename } = uploadQueue.current[0]

    try {
      const form = new FormData()
      form.append('file', { uri, name: 'photo.jpg', type: 'image/jpeg' })
      form.append('filename', filename)   // e.g. "john_482913"
      await fetch(`${SERVER_URL}/upload`, { method: 'POST', body: form })

      uploadQueue.current.shift()
      setPendingCount(uploadQueue.current.length)
      await saveQueue(uploadQueue.current)
      processing.current = false
      processNextInQueue()

    } catch (e) {
      console.error('[upload failed, retrying in 5s]', e)
      processing.current = false
      setTimeout(() => processNextInQueue(), 5000)
    }
  }

  // ── Capture Handler ────────────────────────────────────────────────
  const handleCapture = async () => {
    if (!cameraRef.current || busy.current) return
    busy.current = true

    Animated.sequence([
      Animated.timing(shutterScale, { toValue: 0.84, duration: 75,  useNativeDriver: true }),
      Animated.spring(shutterScale, { toValue: 1,    useNativeDriver: true, speed: 28, bounciness: 12 }),
    ]).start()

    Animated.sequence([
      Animated.timing(flashOpacity, { toValue: 0.9, duration: 50,  useNativeDriver: true }),
      Animated.timing(flashOpacity, { toValue: 0,   duration: 400, useNativeDriver: true }),
    ]).start()

    try {
      const photo    = await cameraRef.current.takePictureAsync({ quality: 0.82, base64: false })
      const filename = await generateFilename(userName)
      uploadQueue.current.push({ uri: photo.uri, filename })
      setPendingCount(uploadQueue.current.length)
      await saveQueue(uploadQueue.current)
      processNextInQueue()
    } catch (e) {
      Alert.alert('Capture Error', String(e))
    } finally {
      busy.current = false
    }
  }

  const handleZoom = (level) => {
    setActiveZoom(level.label)
    setZoom(level.value)
  }

  // ── Not loaded yet ─────────────────────────────────────────────────
  if (userName === null) return <View style={styles.bg} />

  // ── Permission ─────────────────────────────────────────────────────
  if (!permission) return <View style={styles.bg} />

  if (!permission.granted) {
    return (
      <View style={styles.permissionScreen}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.permissionTitle}>Camera Access</Text>
        <Text style={styles.permissionSub}>Required to capture and analyze road conditions</Text>
        <Pressable style={({ pressed }) => [styles.grantBtn, pressed && { opacity: 0.75 }]} onPress={requestPermission}>
          <Text style={styles.grantBtnText}>Allow Camera</Text>
        </Pressable>
      </View>
    )
  }

  // ── Name Screen ────────────────────────────────────────────────────
  if (!userName) {
    return (
      <KeyboardAvoidingView
        style={styles.nameScreen}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <StatusBar barStyle="light-content" />
        <Text style={styles.nameTitle}>Welcome</Text>
        <Text style={styles.nameSub}>Enter your name to get started</Text>
        <TextInput
          style={styles.nameInput}
          placeholder="Your name"
          placeholderTextColor="#4b5563"
          value={nameInput}
          onChangeText={setNameInput}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={handleNameSubmit}
        />
        <Pressable
          style={({ pressed }) => [styles.grantBtn, { marginTop: 12 }, (!nameInput.trim() || pressed) && { opacity: 0.5 }]}
          onPress={handleNameSubmit}
        >
          <Text style={styles.grantBtnText}>Continue</Text>
        </Pressable>
      </KeyboardAvoidingView>
    )
  }

  // ── Main UI ────────────────────────────────────────────────────────
  return (
    <View style={styles.bg}>
      <StatusBar barStyle="light-content" hidden />

      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} zoom={zoom} />

      {/* White flash */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: flashOpacity }]}
      />

      {/* Upload badge — top right, visible when queue has items */}
      {pendingCount > 0 && (
        <View style={styles.badge}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>Uploading {pendingCount}</Text>
        </View>
      )}

      {/* Name chip — top left */}
      <Pressable
        style={styles.nameChip}
        onPress={() => {
          AsyncStorage.removeItem(NAME_KEY)
          setUserName('')
          setNameInput('')
        }}
      >
        <Text style={styles.nameChipText}>{userName}  ✕</Text>
      </Pressable>

      {/* Bottom controls */}
      <Animated.View style={[styles.bottomBar, { opacity: controlsOpacity, transform: [{ translateY: controlsY }] }]}>

        <View style={styles.zoomRow}>
          {ZOOM_LEVELS.map(level => (
            <Pressable
              key={level.label}
              style={[styles.zoomPill, activeZoom === level.label && styles.zoomPillActive]}
              onPress={() => handleZoom(level)}
            >
              <Text style={[styles.zoomText, activeZoom === level.label && styles.zoomTextActive]}>
                {level.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.shutterRow}>
          <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
            <Pressable style={styles.shutter} onPress={handleCapture}>
              <View style={styles.shutterInner} />
            </Pressable>
          </Animated.View>
        </View>

        <View style={styles.bottomRow}>
          <View style={styles.bottomSide} />
          <Text style={styles.modeLabel}>PHOTO</Text>
          <View style={styles.bottomSide}>
            <Pressable
              style={({ pressed }) => [styles.flipBtn, pressed && { opacity: 0.6 }]}
              onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')}
            >
              <Text style={styles.flipIcon}>↺</Text>
            </Pressable>
          </View>
        </View>

      </Animated.View>
    </View>
  )
}

// ── Styles ─────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: '#000',
  },
  nameScreen: {
    flex: 1,
    backgroundColor: '#080810',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  nameTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 8,
  },
  nameSub: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 32,
  },
  nameInput: {
    width: '100%',
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#ffffff20',
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    fontSize: 16,
    color: '#ffffff',
  },
  nameChip: {
    position: 'absolute',
    top: 20,
    left: 20,
    backgroundColor: '#00000088',
    borderWidth: 1,
    borderColor: '#ffffff20',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  nameChipText: {
    color: '#ffffffcc',
    fontSize: 12,
    fontWeight: '600',
  },
  permissionScreen: {
    flex: 1,
    backgroundColor: '#080810',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 10,
  },
  permissionSub: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 36,
  },
  grantBtn: {
    backgroundColor: '#a78bfa',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 28,
  },
  grantBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  badge: {
    position: 'absolute',
    top: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#00000088',
    borderWidth: 1,
    borderColor: '#ffffff20',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#a78bfa',
  },
  badgeText: {
    color: '#ffffffcc',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#111111ee',
    paddingBottom: 36,
    paddingTop: 16,
    gap: 10,
  },
  zoomRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 4,
  },
  zoomPill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  zoomPillActive: {
    backgroundColor: '#3a3a3c',
  },
  zoomText: {
    fontSize: 13,
    color: '#ffffffaa',
    fontWeight: '600',
  },
  zoomTextActive: {
    color: '#FFCC00',
  },
  shutterRow: {
    alignItems: 'center',
    marginVertical: 8,
  },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 3,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#ffffff',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    marginTop: 4,
  },
  bottomSide: {
    width: 52,
    alignItems: 'flex-end',
  },
  modeLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFCC00',
    letterSpacing: 1,
  },
  flipBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#3a3a3caa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flipIcon: {
    fontSize: 24,
    color: '#ffffff',
  },
})
