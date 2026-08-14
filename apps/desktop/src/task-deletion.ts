export interface DeleteTaskLocalFirstOptions {
  deleteLocal: () => Promise<boolean>;
  deleteRemote?: () => Promise<void>;
  remoteEnabled?: boolean;
}

export interface DeleteTaskOutcome {
  localDeleted: boolean;
  remoteDeleted: boolean | null;
  needsPairing: boolean;
  remoteError: string | null;
}

export async function deleteTaskLocalFirst({
  deleteLocal,
  deleteRemote,
  remoteEnabled = true,
}: DeleteTaskLocalFirstOptions): Promise<DeleteTaskOutcome> {
  const localDeleted = await deleteLocal();
  if (!localDeleted) {
    return { localDeleted: false, remoteDeleted: false, needsPairing: false, remoteError: null };
  }
  if (!remoteEnabled || !deleteRemote) {
    return { localDeleted: true, remoteDeleted: null, needsPairing: false, remoteError: null };
  }
  try {
    await deleteRemote();
    return { localDeleted: true, remoteDeleted: true, needsPairing: false, remoteError: null };
  } catch (cause) {
    const remoteError = cause instanceof Error ? cause.message : "DELETE_FAILED";
    return {
      localDeleted: true,
      remoteDeleted: false,
      needsPairing: /401|DEVICE_|AUTH/i.test(remoteError),
      remoteError,
    };
  }
}
