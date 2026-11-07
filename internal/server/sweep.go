package server

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/store"
)

const (
	sweepBatch = 100
	drainBatch = 1000
)

// Sweep does what is due: it purges what the trash has held long enough, removes
// what has waited out its grace period, drops abandoned uploads, and unlinks the
// files of everything that has gone. Each step is its own short transaction, so
// that requests go on in between.
func (s *Server) Sweep(ctx context.Context) error {
	s.sweepMu.Lock()
	defer s.sweepMu.Unlock()
	settings, err := s.store.Settings(ctx)
	if errors.Is(err, store.ErrNotConfigured) {
		return nil
	}
	if err != nil {
		return err
	}
	now := s.cfg.Now()
	if settings.TrashRetentionDays > 0 {
		cutoff := now.Add(-days(settings.TrashRetentionDays))
		if _, err := s.store.MarkExpiredTrash(ctx, cutoff, now, now.Add(days(settings.PurgeGraceDays))); err != nil {
			return err
		}
	}
	for {
		n, err := s.store.RemoveDueNodes(ctx, now, sweepBatch)
		if err != nil {
			return err
		}
		if n < sweepBatch {
			break
		}
	}
	for {
		n, err := s.store.RemoveDueVersions(ctx, now, sweepBatch)
		if err != nil {
			return err
		}
		if n < sweepBatch {
			break
		}
	}
	for {
		n, err := s.store.RemoveStaleUploads(ctx, now.Add(-s.cfg.UploadTTL), sweepBatch)
		if err != nil {
			return err
		}
		if n < sweepBatch {
			break
		}
	}
	return s.drainRemovals(ctx)
}

// RunSweeper sweeps at once and then once per interval, until ctx is done.
func (s *Server) RunSweeper(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := s.Sweep(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("sweep failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// drainRemovals unlinks the files whose rows have gone.
func (s *Server) drainRemovals(ctx context.Context) error {
	s.drainMu.Lock()
	defer s.drainMu.Unlock()
	return s.drainLocked(ctx)
}

// drainLocked forgets a file only once it is gone, so that a crash in between
// repeats the unlink, which is harmless.
func (s *Server) drainLocked(ctx context.Context) error {
	for {
		pending, err := s.store.PendingFileRemovals(ctx, drainBatch)
		if err != nil {
			return err
		}
		for _, r := range pending {
			remove := s.files.RemoveBlob
			if r.Kind == store.RemoveUpload {
				remove = s.files.RemoveUpload
			}
			if err := remove(r.ID); err != nil {
				return err
			}
			if err := s.store.ClearFileRemoval(ctx, r); err != nil {
				return err
			}
		}
		if len(pending) < drainBatch {
			return nil
		}
	}
}

// drainRemovalsLogged frees the disk right after a request that removed
// something. The request has already succeeded, and the sweeper will try again.
// If a pass is running it leaves this to that one, or to the next: a request does
// not queue behind someone else's long list of files.
func (s *Server) drainRemovalsLogged(ctx context.Context) {
	if !s.drainMu.TryLock() {
		return
	}
	defer s.drainMu.Unlock()
	if err := s.drainLocked(context.WithoutCancel(ctx)); err != nil {
		s.log.Error("file removal failed", "error", err)
	}
}

// reconcileFiles brings the stored files into line with the database at startup,
// when nothing else is running. Every step only ever undoes what a crash left
// half done:
//
//   - a temporary file was on its way in, and its request is gone;
//   - a placed file with no row but an upload belongs to a commit that did not
//     finish, and goes back, for the client to commit again;
//   - any other placed file with no row is on its way out;
//   - an upload's file with no row is the same, and a row with no file can never
//     complete, which is also how an upload looks in a restored backup.
func (s *Server) reconcileFiles(ctx context.Context) error {
	uploads, err := s.store.UploadIDs(ctx)
	if err != nil {
		return err
	}
	err = s.files.EachShard(func(shard string, ids []string) error {
		rows, err := s.store.BlobIDsInShard(ctx, shard)
		if err != nil {
			return err
		}
		for _, id := range ids {
			switch {
			case rows[id]:
			case uploads[id]:
				if err := s.files.UnplaceUpload(id); err != nil {
					return err
				}
			default:
				if err := s.files.RemoveBlob(id); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("server: reconcile blobs: %w", err)
	}
	onDisk, err := s.files.CleanTemp()
	if err != nil {
		return fmt.Errorf("server: reconcile uploads: %w", err)
	}
	present := make(map[string]bool, len(onDisk))
	for _, id := range onDisk {
		present[id] = true
		if !uploads[id] {
			if err := s.files.RemoveUpload(id); err != nil {
				return fmt.Errorf("server: reconcile uploads: %w", err)
			}
		}
	}
	for id := range uploads {
		if !present[id] {
			if err := s.store.DeleteUpload(ctx, id); err != nil && !errors.Is(err, store.ErrNotFound) {
				return fmt.Errorf("server: reconcile uploads: %w", err)
			}
		}
	}
	return s.drainRemovals(ctx)
}
