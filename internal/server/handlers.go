package server

import (
	"bytes"
	"context"
	"net/http"

	spec "github.com/Angelmmiguel/yondrive/api"
	oapi "github.com/Angelmmiguel/yondrive/internal/api"
)

var _ oapi.StrictServerInterface = (*Server)(nil)

// GetHealth reports liveness, the build version, whether setup is done and the
// encryption mode.
func (s *Server) GetHealth(context.Context, oapi.GetHealthRequestObject) (oapi.GetHealthResponseObject, error) {
	mode := s.mode.Load()
	return oapi.GetHealth200JSONResponse{
		Status:  oapi.Ok,
		Version: s.cfg.Version,
		Setup:   mode != nil,
		Mode:    mode,
	}, nil
}

// GetOpenAPISpec serves the specification embedded in the binary.
func (s *Server) GetOpenAPISpec(context.Context, oapi.GetOpenAPISpecRequestObject) (oapi.GetOpenAPISpecResponseObject, error) {
	return oapi.GetOpenAPISpec200ApplicationyamlResponse{
		Body:          bytes.NewReader(spec.YAML),
		ContentLength: int64(len(spec.YAML)),
	}, nil
}

// apiHandler mounts the generated routes on mux, each behind guard. Failures
// the generated code meets before a handler runs, such as a malformed request,
// answer with the same JSON error as everything else.
func (s *Server) apiHandler(mux *http.ServeMux) {
	malformed := func(w http.ResponseWriter, _ *http.Request, err error) {
		if !writeFailure(w, err) {
			writeError(w, http.StatusBadRequest, codeBadRequest)
		}
	}
	failed := func(w http.ResponseWriter, r *http.Request, err error) {
		if writeFailure(w, err) {
			return
		}
		s.log.Error("handler failed", "method", r.Method, "path", r.URL.Path, "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal)
	}
	strict := oapi.NewStrictHandlerWithOptions(s, []oapi.StrictMiddlewareFunc{s.guard}, oapi.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  malformed,
		ResponseErrorHandlerFunc: failed,
	})
	oapi.HandlerWithOptions(strict, oapi.StdHTTPServerOptions{
		BaseRouter:       mux,
		ErrorHandlerFunc: malformed,
	})
}
