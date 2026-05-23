import { useState } from "react";
import { Button, Stack, Text, TextInput } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import { SettingsSection } from "../../ui/SettingsSection";
import { Divider } from "./Primitives";

// ---------------------------------------------------------------------------
// Danger zone — owner-only. Hosts two irreversible actions side by side:
//
//   1. Transfer ownership to another existing global user. The current
//      owner loses owner-level access immediately; the new owner gets an
//      auto-minted ConferenceIdentity on their next visit.
//   2. Delete the conference and every related row (identities, submissions,
//      slots, experts, notifications, ...) via the schema's onDelete: Cascade
//      rules.
//
// Both actions require an explicit confirm step — the transfer asks for the
// new owner's email; the delete asks the owner to retype the conference
// name. After either succeeds the parent navigates the user away (`onBack`
// in Conference.tsx) since neither principal still has owner-level access
// to render the Settings tab on the next reload.

export function DangerZone({
  slug, confName, busy, onBusy, onDeleted, onTransferred,
}: {
  slug: string;
  confName: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onDeleted: () => void;
  onTransferred: () => void;
}) {
  return (
    <SettingsSection
      title="Danger zone"
      description="These actions are irreversible. Transferring drops you from owner to no role on this conference. Deleting removes every participant, session, slot, and booking."
    >
      <TransferOwnershipAction
        slug={slug}
        busy={busy}
        onBusy={onBusy}
        onTransferred={onTransferred}
      />
      <Divider />
      <DeleteAction
        slug={slug}
        confName={confName}
        busy={busy}
        onBusy={onBusy}
        onDeleted={onDeleted}
      />
    </SettingsSection>
  );
}

export function TransferOwnershipAction({
  slug, busy, onBusy, onTransferred,
}: {
  slug: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onTransferred: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [email, setEmail] = useState("");

  async function doTransfer() {
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      toast.error("Enter the new owner's email.");
      return;
    }
    onBusy(true);
    try {
      await api.conferences.transferOwnership({ slug, new_owner_email: trimmed });
      onTransferred();
    } catch (e) {
      // Server domain codes carried via ORPCError.message; surface the
      // friendly variant rather than the raw token.
      const code = errorCode(e);
      toast.error(
        code === "user_not_found" ? "No registered account uses that email."
          : code === "same_user" ? "That email is already the owner."
            : code,
      );
      onBusy(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Transfer ownership</div>
      <Text muted>
        Hand this conference over to another registered user. You lose
        owner-level access immediately.
      </Text>
      <div style={{ marginTop: 12 }}>
        {!confirming ? (
          <Button
            variant="danger"
            onClick={() => { setConfirming(true); setEmail(""); }}
            disabled={busy}
          >
            Transfer ownership…
          </Button>
        ) : (
          <Stack gap="condensed">
            <Text>
              Enter the email of the user who should become the new owner.
              They must already have an account on this instance.
            </Text>
            <TextInput
              label="New owner email"
              type="email"
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@example.com"
            />
            <Stack direction="row" gap="condensed">
              <Button
                variant="danger"
                onClick={doTransfer}
                disabled={busy || email.trim().length === 0}
              >
                Transfer ownership
              </Button>
              <Button
                onClick={() => { setConfirming(false); setEmail(""); }}
                disabled={busy}
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        )}
      </div>
    </div>
  );
}

export function DeleteAction({
  slug, confName, busy, onBusy, onDeleted,
}: {
  slug: string;
  confName: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  async function doDelete() {
    if (typed.trim() !== confName) {
      toast.error("Type the conference name exactly to confirm.");
      return;
    }
    onBusy(true);
    try {
      await api.conferences.delete({ slug });
      onDeleted();
    } catch (e) {
      toast.error(errorCode(e));
      onBusy(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Delete conference</div>
      <Text muted>
        Permanently remove this conference and everything inside it.
      </Text>
      <div style={{ marginTop: 12 }}>
        {!confirming ? (
          <Button
            variant="danger"
            onClick={() => { setConfirming(true); setTyped(""); }}
            disabled={busy}
          >
            Delete conference…
          </Button>
        ) : (
          <Stack gap="condensed">
            <Text>
              Type <strong>{confName}</strong> to confirm. Every participant,
              session, slot, and booking will be removed immediately.
            </Text>
            <TextInput
              label="Conference name"
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
            />
            <Stack direction="row" gap="condensed">
              <Button
                variant="danger"
                onClick={doDelete}
                disabled={busy || typed.trim() !== confName}
              >
                I understand, delete it
              </Button>
              <Button
                onClick={() => { setConfirming(false); setTyped(""); }}
                disabled={busy}
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        )}
      </div>
    </div>
  );
}
