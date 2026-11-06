package server

import (
	"encoding/json"
	"net/http"
)

// Error codes sent to the client as {"code":"<code>"}. They are stable
// identifiers, never free-form messages: an internal error must not describe
// the state of the server.
const (
	codeForbidden = "forbidden"
	codeNotFound  = "not_found"
	codeInternal  = "internal"
)

type errorBody struct {
	Code string `json:"code"`
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, errorBody{Code: code})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
