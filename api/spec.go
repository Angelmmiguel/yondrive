// Package spec embeds the OpenAPI document the server implements, so the
// binary can serve exactly the specification it was built from.
package spec

import _ "embed"

// YAML is the OpenAPI document, as written in openapi.yaml.
//
//go:embed openapi.yaml
var YAML []byte
