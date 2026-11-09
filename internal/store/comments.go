package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Errors of comments. Callers match them with errors.Is.
var (
	// ErrCommentLimit means the file has all the comments it takes.
	ErrCommentLimit = errors.New("store: the file has all the comments it takes")
	// ErrNotThread means a comment that is not the first of its thread was named
	// where only the first will do.
	ErrNotThread = errors.New("store: not the first comment of a thread")
	// ErrHasReplies means a thread's first comment has replies by others, which
	// deleting it would take with it.
	ErrHasReplies = errors.New("store: the thread has replies by others")
)

// CommentAnchor is where a thread points, sealed and signed by SignerID.
type CommentAnchor struct {
	KeyGeneration int64
	Sealed        []byte
	Signature     []byte
	SignerID      string
	UpdatedAt     time.Time
}

// Comment is a comment on a file, or a reply. The body and the anchor are
// opaque. The first comment of a thread has its own id as ThreadID, and only it
// has an Anchor and a resolved state.
type Comment struct {
	Seq           int64
	ID            string
	NodeID        string
	ThreadID      string
	AuthorID      string
	AuthorName    string
	KeyGeneration int64
	SealedBody    []byte
	Signature     []byte
	Anchor        *CommentAnchor
	CreatedAt     time.Time
	EditedAt      time.Time
	ResolvedBy    string
	ResolvedAt    time.Time
}

const commentSelect = `SELECT c.seq, c.id, c.node_id, c.thread_id, c.author_id, u.username, c.key_generation,
	c.sealed_body, c.signature, c.anchor_generation, c.sealed_anchor, c.anchor_signature,
	coalesce(c.anchor_signer_id, ''), c.anchor_updated_at, coalesce(c.resolved_by, ''), c.resolved_at,
	c.created_at, c.edited_at
	FROM comments c JOIN users u ON u.id = c.author_id `

func scanComment(row interface{ Scan(...any) error }) (Comment, error) {
	var c Comment
	var anchorGeneration, anchorUpdated, resolved, edited sql.NullInt64
	var anchor, anchorSignature []byte
	var signer string
	var created int64
	err := row.Scan(&c.Seq, &c.ID, &c.NodeID, &c.ThreadID, &c.AuthorID, &c.AuthorName, &c.KeyGeneration,
		&c.SealedBody, &c.Signature, &anchorGeneration, &anchor, &anchorSignature,
		&signer, &anchorUpdated, &c.ResolvedBy, &resolved, &created, &edited)
	c.SealedBody, c.Signature = nonNil(c.SealedBody), nonNil(c.Signature)
	if anchorGeneration.Valid {
		c.Anchor = &CommentAnchor{
			KeyGeneration: anchorGeneration.Int64,
			Sealed:        nonNil(anchor),
			Signature:     nonNil(anchorSignature),
			SignerID:      signer,
			UpdatedAt:     fromNull(anchorUpdated),
		}
	}
	c.CreatedAt = time.Unix(created, 0).UTC()
	c.EditedAt, c.ResolvedAt = fromNull(edited), fromNull(resolved)
	return c, err
}

func oneComment(ctx context.Context, q querier, nodeID, id string) (Comment, error) {
	c, err := scanComment(q.QueryRowContext(ctx, commentSelect+"WHERE c.node_id = ? AND c.id = ?", nodeID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Comment{}, ErrNotFound
	}
	if err != nil {
		return Comment{}, fmt.Errorf("store: read comment: %w", err)
	}
	return c, nil
}

// CommentByID returns a comment on a node, or ErrNotFound.
func (s *Store) CommentByID(ctx context.Context, nodeID, id string) (Comment, error) {
	return oneComment(ctx, s.read, nodeID, id)
}

// ListComments returns a page of a node's comments, oldest first, after the
// sequence number given.
func (s *Store) ListComments(ctx context.Context, nodeID string, after int64, limit int) ([]Comment, error) {
	rows, err := s.read.QueryContext(ctx, commentSelect+"WHERE c.node_id = ? AND c.seq > ? ORDER BY c.seq LIMIT ?", nodeID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list comments: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Comment
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list comments: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list comments: %w", err)
	}
	return out, nil
}

// KeyChain returns the links from a node's current key back to the generation
// given, newest first. It is empty when that generation is the current one.
func (s *Store) KeyChain(ctx context.Context, nodeID string, from int64) ([]KeyLink, error) {
	return keyChain(ctx, s.read, nodeID, from)
}

// commentTarget loads a file that may take a comment sealed under generation:
// one out of the trash, whose key has not moved on.
func commentTarget(ctx context.Context, tx *sql.Tx, nodeID string, generations ...int64) (Node, error) {
	n, err := oneNode(ctx, tx, "id = ?", nodeID)
	if err != nil {
		return Node{}, err
	}
	if n.Kind != KindFile {
		return Node{}, ErrNotFile
	}
	if err := checkNotTrashed(ctx, tx, nodeID); err != nil {
		return Node{}, err
	}
	for _, g := range generations {
		if g != n.KeyGeneration {
			return Node{}, ErrKeyGeneration
		}
	}
	return n, nil
}

// commented bumps the node's count of comment changes and tells everyone who can
// reach it through the journal.
func commented(ctx context.Context, tx *sql.Tx, n Node, at time.Time) error {
	if _, err := tx.ExecContext(ctx, "UPDATE nodes SET comment_seq = comment_seq + 1 WHERE id = ?", n.ID); err != nil {
		return fmt.Errorf("store: count comment change: %w", err)
	}
	return recordChange(ctx, tx, n.OwnerID, n.ID, OpCommented, at)
}

// CreateComment adds a comment, or a reply when its ThreadID names another, to a
// file that has fewer than limit. Everyone else who can reach the file through
// its owner or a grant gets a notice.
func (s *Store) CreateComment(ctx context.Context, c Comment, limit int) (Comment, error) {
	var out Comment
	err := s.tx(ctx, func(tx *sql.Tx) error {
		generations := []int64{c.KeyGeneration}
		if c.Anchor != nil {
			generations = append(generations, c.Anchor.KeyGeneration)
		}
		n, err := commentTarget(ctx, tx, c.NodeID, generations...)
		if err != nil {
			return err
		}
		if c.ThreadID != c.ID {
			root, err := oneComment(ctx, tx, c.NodeID, c.ThreadID)
			if err != nil {
				return err
			}
			if root.ThreadID != root.ID || c.Anchor != nil {
				return ErrNotThread
			}
		}
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM comments WHERE node_id = ?", c.NodeID).Scan(&count); err != nil {
			return fmt.Errorf("store: count comments: %w", err)
		}
		if count >= limit {
			return ErrCommentLimit
		}
		var taken int
		err = tx.QueryRowContext(ctx, "SELECT 1 FROM comments WHERE id = ?", c.ID).Scan(&taken)
		if err == nil {
			return ErrIDTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: check comment id: %w", err)
		}
		var anchorGeneration, anchorUpdated sql.NullInt64
		var anchor, anchorSignature []byte
		var signer sql.NullString
		if c.Anchor != nil {
			anchorGeneration = sql.NullInt64{Int64: c.Anchor.KeyGeneration, Valid: true}
			anchorUpdated = sql.NullInt64{Int64: c.CreatedAt.Unix(), Valid: true}
			anchor, anchorSignature = nonNil(c.Anchor.Sealed), nonNil(c.Anchor.Signature)
			signer = sql.NullString{String: c.AuthorID, Valid: true}
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO comments (id, node_id, thread_id, author_id, key_generation,
			sealed_body, signature, anchor_generation, sealed_anchor, anchor_signature, anchor_signer_id,
			anchor_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			c.ID, c.NodeID, c.ThreadID, c.AuthorID, c.KeyGeneration, nonNil(c.SealedBody), nonNil(c.Signature),
			anchorGeneration, anchor, anchorSignature, signer, anchorUpdated, c.CreatedAt.Unix())
		if err != nil {
			return fmt.Errorf("store: insert comment: %w", err)
		}
		if err := notice(ctx, tx, n, c); err != nil {
			return err
		}
		if err := commented(ctx, tx, n, c.CreatedAt); err != nil {
			return err
		}
		out, err = oneComment(ctx, tx, c.NodeID, c.ID)
		return err
	})
	return out, err
}

// notice tells the owner and every grantee on the node or above it, but the
// author, that a comment arrived. Whether each can read the node now is the
// listing's question.
func notice(ctx context.Context, tx *sql.Tx, n Node, c Comment) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO comment_notices (user_id, node_id, comment_id, author_id, count, created_at)
		WITH RECURSIVE up (id, parent_id, depth) AS (
			SELECT id, parent_id, 0 FROM nodes WHERE id = ?
			UNION ALL
			SELECT p.id, p.parent_id, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id WHERE up.depth <= ?
		), audience (user_id) AS (
			SELECT ? UNION SELECT g.grantee_id FROM up JOIN grants g ON g.node_id = up.id
		) SELECT user_id, ?, ?, ?, 1, ? FROM audience WHERE user_id != ?
		ON CONFLICT (user_id, node_id) DO UPDATE SET comment_id = excluded.comment_id,
			author_id = excluded.author_id, count = count + 1, created_at = excluded.created_at`,
		n.ID, MaxTreeDepth+1, n.OwnerID, n.ID, c.ID, c.AuthorID, c.CreatedAt.Unix(), c.AuthorID)
	if err != nil {
		return fmt.Errorf("store: notify comment: %w", err)
	}
	return nil
}

// UpdateCommentBody replaces a comment's body and its signature, sealed under
// the node's current generation.
func (s *Store) UpdateCommentBody(ctx context.Context, nodeID, id string, generation int64, body, signature []byte, now time.Time) (Comment, error) {
	return s.updateComment(ctx, nodeID, id, []int64{generation}, now, func(tx *sql.Tx, _ Comment) error {
		_, err := tx.ExecContext(ctx, "UPDATE comments SET key_generation = ?, sealed_body = ?, signature = ?, edited_at = ? WHERE id = ?",
			generation, nonNil(body), nonNil(signature), now.Unix(), id)
		return err
	})
}

// SetCommentAnchor replaces a thread's anchor with one its signer sealed under
// the node's current generation.
func (s *Store) SetCommentAnchor(ctx context.Context, nodeID, id string, a CommentAnchor, now time.Time) (Comment, error) {
	return s.updateComment(ctx, nodeID, id, []int64{a.KeyGeneration}, now, func(tx *sql.Tx, c Comment) error {
		if c.ThreadID != c.ID {
			return ErrNotThread
		}
		_, err := tx.ExecContext(ctx, `UPDATE comments SET anchor_generation = ?, sealed_anchor = ?, anchor_signature = ?,
			anchor_signer_id = ?, anchor_updated_at = ? WHERE id = ?`,
			a.KeyGeneration, nonNil(a.Sealed), nonNil(a.Signature), a.SignerID, now.Unix(), id)
		return err
	})
}

// ResolveComment resolves a thread for by, or reopens it.
func (s *Store) ResolveComment(ctx context.Context, nodeID, id, by string, resolved bool, now time.Time) (Comment, error) {
	return s.updateComment(ctx, nodeID, id, nil, now, func(tx *sql.Tx, c Comment) error {
		if c.ThreadID != c.ID {
			return ErrNotThread
		}
		var err error
		if resolved {
			_, err = tx.ExecContext(ctx, "UPDATE comments SET resolved_by = ?, resolved_at = ? WHERE id = ?", by, now.Unix(), id)
		} else {
			_, err = tx.ExecContext(ctx, "UPDATE comments SET resolved_by = NULL, resolved_at = NULL WHERE id = ?", id)
		}
		return err
	})
}

func (s *Store) updateComment(ctx context.Context, nodeID, id string, generations []int64, now time.Time, apply func(*sql.Tx, Comment) error) (Comment, error) {
	var out Comment
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n, err := commentTarget(ctx, tx, nodeID, generations...)
		if err != nil {
			return err
		}
		c, err := oneComment(ctx, tx, nodeID, id)
		if err != nil {
			return err
		}
		if err := apply(tx, c); err != nil {
			if errors.Is(err, ErrNotThread) {
				return err
			}
			return fmt.Errorf("store: update comment: %w", err)
		}
		if err := commented(ctx, tx, n, now); err != nil {
			return err
		}
		out, err = oneComment(ctx, tx, nodeID, id)
		return err
	})
	return out, err
}

// DeleteComment removes a comment, and with the first of a thread its replies.
// With an author named, it refuses the first comment of a thread that has
// replies by anyone else, so one person cannot take others' words with theirs.
// A file in the trash keeps its comments as they are.
func (s *Store) DeleteComment(ctx context.Context, nodeID, id, sparing string, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		n, err := commentTarget(ctx, tx, nodeID)
		if err != nil {
			return err
		}
		if sparing != "" {
			var others int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM comments
				WHERE node_id = ? AND thread_id = ? AND id != thread_id AND author_id != ?`,
				nodeID, id, sparing).Scan(&others); err != nil {
				return fmt.Errorf("store: count replies: %w", err)
			}
			if others > 0 {
				return ErrHasReplies
			}
		}
		res, err := tx.ExecContext(ctx, "DELETE FROM comments WHERE node_id = ? AND id = ?", nodeID, id)
		if err != nil {
			return fmt.Errorf("store: delete comment: %w", err)
		}
		if gone, err := res.RowsAffected(); err != nil || gone == 0 {
			return ErrNotFound
		}
		return commented(ctx, tx, n, now)
	})
}

// CommentNotice says that a user has unread comments on a file.
type CommentNotice struct {
	NodeID    string
	CommentID string
	AuthorID  string
	Count     int
	CreatedAt time.Time
}

// ListCommentNotices returns a user's newest notices.
func (s *Store) ListCommentNotices(ctx context.Context, userID string, limit int) ([]CommentNotice, error) {
	rows, err := s.read.QueryContext(ctx, `SELECT node_id, comment_id, author_id, count, created_at FROM comment_notices
		WHERE user_id = ? ORDER BY created_at DESC, node_id LIMIT ?`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list comment notices: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []CommentNotice
	for rows.Next() {
		var n CommentNotice
		var created int64
		if err := rows.Scan(&n.NodeID, &n.CommentID, &n.AuthorID, &n.Count, &created); err != nil {
			return nil, fmt.Errorf("store: list comment notices: %w", err)
		}
		n.CreatedAt = time.Unix(created, 0).UTC()
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list comment notices: %w", err)
	}
	return out, nil
}

// MarkCommentNoticesRead forgets a user's notices on the files named, or on
// all of them if nodeIDs is nil.
func (s *Store) MarkCommentNoticesRead(ctx context.Context, userID string, nodeIDs []string) error {
	query := "DELETE FROM comment_notices WHERE user_id = ?"
	args := []any{userID}
	if nodeIDs != nil {
		list, err := json.Marshal(nodeIDs)
		if err != nil {
			return fmt.Errorf("store: mark comment notices: %w", err)
		}
		query += " AND node_id IN (SELECT value FROM json_each(?))"
		args = append(args, string(list))
	}
	if _, err := s.write.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("store: mark comment notices: %w", err)
	}
	return nil
}
