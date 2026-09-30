// ICE servers for WebRTC. Add TURN here, e.g.
// { urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
