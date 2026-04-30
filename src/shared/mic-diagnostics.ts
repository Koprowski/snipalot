/**
 * Mic capture diagnostics — collected in the recorder renderer after
 * getUserMedia and sent to main on `recorder:state` 'started' so we log
 * and persist `mic_diagnostics.json` in the session folder.
 */

export interface MicInputDeviceSummary {
  deviceId: string;
  label: string;
  groupId: string;
}

export interface MicActiveTrackSummary {
  label: string;
  id: string;
  enabled: boolean;
  muted: boolean;
  readyState: string;
  /** Subset of MediaTrackSettings (serialized for JSON). */
  settings: Record<string, unknown>;
}

export interface MicDiagnosticsPayload {
  capturedAtIso: string;
  microphoneRequested: boolean;
  microphoneGranted: boolean;
  getUserMediaError: string | null;
  activeAudioTrack: MicActiveTrackSummary | null;
  audioInputDevices: MicInputDeviceSummary[];
}
