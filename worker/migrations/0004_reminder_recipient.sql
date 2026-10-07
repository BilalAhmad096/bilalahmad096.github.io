-- Who a reminder is for, as a key the Worker maps to an address held in a secret
-- ('me' -> the owner, 'wife' -> REMINDER_TO_WIFE). Existing reminders stay with the owner.
ALTER TABLE reminders ADD COLUMN recipient TEXT NOT NULL DEFAULT 'me';
