import {
  StyleSheet, Text, View, Pressable,
  StatusBar, Animated, Alert,
} from 'react-native'
import { useState, useRef, useEffect } from 'react'
import { CameraView, useCameraPermissions } from 'expo-camera'

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL
const ZOOM_LEVELS = [
  { label: '1x', value: 0 },
  { label: '2x', value: 0.5 },
]

export default function Home() {
  const [permission, requestPermission] = useCameraPermissions()
  const [facing, setFacing]             = useState('back')
  const [activeZoom, setActiveZoom]     = useState('1x')
  const [zoom, setZoom]                 = useState(0)
  const [pendingCount, setPendingCount] = useState(0)  // images waiting to upload

  const cameraRef   = useRef(null)
  const busy        = useRef(false)   // prevents double-tap during capture
  const uploadQueue = useRef([])      // actual queue array (mutable, no re-render)
  const processing  = useRef(false)   // prevents concurrent uploads

  // ── Animations ─────────────────────────────────────────────────────
  const flashOpacity    = useRef(new Animated.Value(0)).current
  const shutterScale    = useRef(new Animated.Value(1)).current
  const controlsOpacity = useRef(new Animated.Value(0)).current
  const controlsY       = useRef(new Animated.Value(60)).current

  useEffect(() => {
    Animated.parallel([
      Animated.timing(controlsOpacity, { toValue: 1, duration: 500, useNativeDriver: true, delay: 200 }),
      Animated.timing(controlsY,       { toValue: 0, duration: 500, useNativeDriver: true, delay: 200 }),
    ]).start()
  }, [])

  // ── Queue Processor ────────────────────────────────────────────────
  // Picks one image at a time from the queue and uploads it
  const processNextInQueue = async () => {
    if (processing.current || uploadQueue.current.length === 0) return
    processing.current = true

    const uri = uploadQueue.current[0]
    try {
      const form = new FormData()
      form.append('file', { uri, name: 'photo.jpg', type: 'image/jpeg' })
      await fetch(`${SERVER_URL}/upload`, { method: 'POST', body: form })
    } catch (e) {
      console.error('[queue upload error]', e)
    } finally {
      uploadQueue.current.shift()                  // remove uploaded item
      setPendingCount(uploadQueue.current.length)  // update badge
      processing.current = false
      processNextInQueue()                         // process next item if any
    }
  }

  // ── Capture Handler ────────────────────────────────────────────────
  const handleCapture = async () => {
    if (!cameraRef.current || busy.current) return
    busy.current = true

    // Shutter animation
    Animated.sequence([
      Animated.timing(shutterScale, { toValue: 0.84, duration: 75,  useNativeDriver: true }),
      Animated.spring(shutterScale, { toValue: 1,    useNativeDriver: true, speed: 28, bounciness: 12 }),
    ]).start()

    // Flash animation
    Animated.sequence([
      Animated.timing(flashOpacity, { toValue: 0.9, duration: 50,  useNativeDriver: true }),
      Animated.timing(flashOpacity, { toValue: 0,   duration: 400, useNativeDriver: true }),
    ]).start()

    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.82, base64: false })
      // Add to queue and immediately stay on camera — no preview, no waiting
      uploadQueue.current.push(photo.uri)
      setPendingCount(uploadQueue.current.length)
      processNextInQueue()
    } catch (e) {
      Alert.alert('Capture Error', String(e))
    } finally {
      busy.current = false  // ready for next shot immediately
    }
  }

  const handleZoom = (level) => {
    setActiveZoom(level.label)
    setZoom(level.value)
  }

  // ── Permission ─────────────────────────────────────────────────────
  if (!permission) return <View style={styles.bg} />

  if (!permission.granted) {
    return (
      <View style={styles.permissionScreen}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.permissionTitle}>Camera Access</Text>
        <Text style={styles.permissionSub}>Required to capture and analyze through Model</Text>
        <Pressable style={({ pressed }) => [styles.grantBtn, pressed && { opacity: 0.75 }]} onPress={requestPermission}>
          <Text style={styles.grantBtnText}>Allow Camera</Text>
        </Pressable>
      </View>
    )
  }

  // ── Main UI ────────────────────────────────────────────────────────
  return (
    <View style={styles.bg}>
      <StatusBar barStyle="light-content" hidden />

      {/* Camera — always mounted */}
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} zoom={zoom} />

      {/* White flash */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: flashOpacity }]}
      />

      {/* Upload queue badge — shows pending count when uploading */}
      {pendingCount > 0 && (
        <View style={styles.badge}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>Uploading {pendingCount}</Text>
        </View>
      )}

      {/* Bottom controls */}
      <Animated.View style={[styles.bottomBar, { opacity: controlsOpacity, transform: [{ translateY: controlsY }] }]}>

        {/* Zoom pills */}
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

        {/* Shutter */}
        <View style={styles.shutterRow}>
          <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
            <Pressable style={styles.shutter} onPress={handleCapture}>
              <View style={styles.shutterInner} />
            </Pressable>
          </Animated.View>
        </View>

        {/* Bottom row: label | flip */}
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

  // ── Permission ──
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

  // ── Upload badge ──
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

  // ── Bottom bar ──
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

  // ── Zoom ──
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

  // ── Shutter ──
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

  // ── Bottom row ──
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
