import {
  StyleSheet, Text, View, Pressable, Image,
  StatusBar, Animated, ActivityIndicator,
} from 'react-native'
import { useState, useRef, useEffect } from 'react'
import { CameraView, useCameraPermissions } from 'expo-camera'

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL
const ZOOM_LEVELS = [
  { label: '1x',  value: 0 },
  { label: '2x',  value: 0.5 },
]



export default function Home() {
  const [permission, requestPermission] = useCameraPermissions()
  const [capturedUri, setCapturedUri]   = useState(null)
  const [uploadStatus, setUploadStatus] = useState('idle')
  const [facing, setFacing]             = useState('back')
  const [activeZoom, setActiveZoom]     = useState('1x')
  const [zoom, setZoom]                 = useState(0)
  const cameraRef   = useRef(null)
  const busy        = useRef(false)
  const cameraReady = useRef(true)

  // ── Animations ────────────────────────────────────────────────────
  const flashOpacity    = useRef(new Animated.Value(0)).current
  const shutterScale    = useRef(new Animated.Value(1)).current
  const previewOpacity  = useRef(new Animated.Value(0)).current
  const controlsOpacity = useRef(new Animated.Value(0)).current
  const controlsY       = useRef(new Animated.Value(60)).current
  useEffect(() => {
    Animated.parallel([
      Animated.timing(controlsOpacity, { toValue: 1, duration: 500, useNativeDriver: true, delay: 200 }),
      Animated.timing(controlsY,       { toValue: 0, duration: 500, useNativeDriver: true, delay: 200 }),
    ]).start()
  }, [])

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCapture = async () => {
    if (!cameraRef.current || busy.current || !cameraReady.current) return
    busy.current = true
    previewOpacity.setValue(0)

    Animated.sequence([
      Animated.timing(shutterScale, { toValue: 0.84, duration: 75,  useNativeDriver: true }),
      Animated.spring(shutterScale, { toValue: 1,    useNativeDriver: true, speed: 28, bounciness: 12 }),
    ]).start()

    Animated.sequence([
      Animated.timing(flashOpacity, { toValue: 0.9,  duration: 50,  useNativeDriver: true }),
      Animated.timing(flashOpacity, { toValue: 0,    duration: 400, useNativeDriver: true }),
    ]).start()

    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.82, base64: false })
      setCapturedUri(photo.uri)
      setUploadStatus('uploading')
      Animated.timing(previewOpacity, { toValue: 1, duration: 360, useNativeDriver: true }).start()

      // 2026-03-20 — Tehman fixed this
      // Previously had: headers: { 'Content-Type': 'multipart/form-data' } in const res after method POST
      // Manually setting Content-Type without the boundary broke multipart parsing in the production APK.
      // Expo Go worked because dev mode is lenient, but the APK rejected it instantly.
      // Fix: remove the headers entirely so React Native auto-generates Content-Type with the correct boundary.
      const form = new FormData()
      form.append('file', { uri: photo.uri, name: 'photo.jpg', type: 'image/jpeg' })
      const res = await fetch(`${SERVER_URL}/upload`, {
        method: 'POST', body: form,
      })
      setUploadStatus(res.ok ? 'done' : 'error')
    } catch (e) {
      console.error('[upload error]', e)
      setUploadStatus('error')
    } finally {
      busy.current = false
    }
  }

  // "react-native": "^0.81.5",
  // THis is also changed to 0.76.3 because of APK Camera not working

  const handleRetake = () => {
    cameraReady.current = false
    Animated.timing(previewOpacity, { toValue: 0, duration: 260, useNativeDriver: true }).start(() => {
      setCapturedUri(null)
      setUploadStatus('idle')
      // Give camera ~400ms to fully resume after preview clears
      setTimeout(() => { cameraReady.current = true }, 400)
    })
  }

  const handleZoom = (level) => {
    setActiveZoom(level.label)
    setZoom(level.value)
  }

  // ── Permission ────────────────────────────────────────────────────
  if (!permission) return <View style={styles.bg} />

  if (!permission.granted) {
    return (
      <View style={styles.permissionScreen}>
        <StatusBar barStyle="light-content" />
        <Text style={styles.permissionTitle}>Camera Access</Text>
        <Text style={styles.permissionSub}>Required to capture and send images to your laptop</Text>
        <Pressable style={({ pressed }) => [styles.grantBtn, pressed && { opacity: 0.75 }]} onPress={requestPermission}>
          <Text style={styles.grantBtnText}>Allow Camera</Text>
        </Pressable>
      </View>
    )
  }

  // ── Main UI ───────────────────────────────────────────────────────
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

      {/* ── Preview overlay ── */}
      {capturedUri && (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: previewOpacity }]}>
          <Image source={{ uri: capturedUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />

          {/* Preview bottom bar */}
          <View style={styles.previewBar}>
            <Pressable
              style={({ pressed }) => [styles.retakeBtn, pressed && { opacity: 0.5 }]}
              onPress={handleRetake}
            >
              <Text style={styles.retakeBtnText}>↩  Retake</Text>
            </Pressable>

            <View style={styles.previewStatusBox}>
              {uploadStatus === 'uploading' && (
                <View style={styles.previewStatusRow}>
                  <ActivityIndicator size="small" color="#aaaaaa" />
                  <Text style={styles.previewStatusText}>Sending…</Text>
                </View>
              )}
              {uploadStatus === 'done' && (
                <Text style={styles.previewStatusDone}>✓  Sent</Text>
              )}
              {uploadStatus === 'error' && (
                <Text style={styles.previewStatusError}>✕  Failed</Text>
              )}
            </View>
          </View>
        </Animated.View>
      )}

      {/* ── Camera bottom controls ── */}
      {!capturedUri && (
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

          {/* Bottom row: PHOTO label | flip */}
          <View style={styles.bottomRow}>
            <View style={styles.bottomSide} />

            <Text style={styles.modeActive}>KHURRaAM</Text>

            {/* Flip camera */}
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
      )}
    </View>
  )
}

// ── Styles ────────────────────────────────────────────────────────
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
  modeActive: {
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

  // ── Preview ──
  statusBadge: {
    position: 'absolute',
    bottom: 110,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  badgeUploading: { backgroundColor: '#00000088', borderColor: '#ffffff30' },
  badgeDone:      { backgroundColor: '#4ade8022', borderColor: '#4ade8055' },
  badgeError:     { backgroundColor: '#f8717122', borderColor: '#f8717155' },
  badgeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  previewBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#111111ee',
    paddingBottom: 44,
    paddingTop: 18,
    paddingHorizontal: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#ffffff10',
  },
  retakeBtn: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  retakeBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  previewStatusBox: {
    alignItems: 'flex-end',
  },
  previewStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  previewStatusText: {
    color: '#aaaaaa',
    fontSize: 14,
    fontWeight: '500',
  },
  previewStatusDone: {
    color: '#4ade80',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  previewStatusError: {
    color: '#f87171',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
})
