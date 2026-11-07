package server

// SessionKeyCount returns how many session keys are held in memory.
func (s *Server) SessionKeyCount() int { return s.keys.Len() }
