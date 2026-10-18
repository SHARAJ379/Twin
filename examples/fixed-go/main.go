// The same app as broken-go, with its three bugs actually fixed. The route
// shapes are identical on purpose - only where state lives changed.
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var itemsMu sync.Mutex

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// FIXED: identity lives in a signed cookie, not server memory. Any instance
// that's given the same SESSION_SECRET can verify it, so login survives a switch.
func sign(secret, value string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	return value + "." + hex.EncodeToString(mac.Sum(nil))
}

func verify(secret, signed string) (string, bool) {
	idx := strings.LastIndex(signed, ".")
	if idx == -1 {
		return "", false
	}
	value, sig := signed[:idx], signed[idx+1:]
	expected := sign(secret, value)
	expectedSig := expected[idx+1:]
	if subtle.ConstantTimeCompare([]byte(sig), []byte(expectedSig)) != 1 {
		return "", false
	}
	return value, true
}

// FIXED: items live at dataFile - point every instance at the same shared
// path and they all see the same data. Plain read-modify-write, no
// cross-process locking: fine for a demo app, not a production-grade store.
func readItems(dataFile string) []Item {
	data, err := os.ReadFile(dataFile)
	if err != nil {
		return []Item{}
	}
	var items []Item
	if err := json.Unmarshal(data, &items); err != nil {
		return []Item{}
	}
	return items
}

func writeItems(dataFile string, items []Item) error {
	data, err := json.Marshal(items)
	if err != nil {
		return err
	}
	return os.WriteFile(dataFile, data, 0o644)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSONBody(r *http.Request) (map[string]any, error) {
	var body map[string]any
	defer r.Body.Close()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return map[string]any{}, nil
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, err
	}
	return body, nil
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	secret := os.Getenv("SESSION_SECRET")
	if secret == "" {
		secret = "dev-secret-not-for-production"
	}
	dataFile := os.Getenv("DATA_FILE")
	if dataFile == "" {
		dataFile = "data.json"
	}
	uploadDir := os.Getenv("UPLOAD_DIR")
	if uploadDir == "" {
		uploadDir = "uploads"
	}
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dataFile), 0o755); err != nil {
		log.Fatal(err)
	}

	requireSession := func(r *http.Request) (string, bool) {
		cookie, err := r.Cookie("sid")
		if err != nil {
			return "", false
		}
		return verify(secret, cookie.Value)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("POST /signup", func(w http.ResponseWriter, r *http.Request) {
		body, err := readJSONBody(r)
		if err != nil {
			writeError(w, 400, "invalid json")
			return
		}
		email, _ := body["email"].(string)
		password, _ := body["password"].(string)
		if email == "" || password == "" {
			writeError(w, 400, "email and password required")
			return
		}
		writeJSON(w, 201, map[string]string{"email": email})
	})

	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) {
		body, err := readJSONBody(r)
		if err != nil {
			writeError(w, 400, "invalid json")
			return
		}
		email, _ := body["email"].(string)
		password, _ := body["password"].(string)
		if email == "" || password == "" {
			writeError(w, 400, "email and password required")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "sid", Value: sign(secret, email), HttpOnly: true, Path: "/"})
		writeJSON(w, 200, map[string]string{"email": email})
	})

	mux.HandleFunc("GET /me", func(w http.ResponseWriter, r *http.Request) {
		email, ok := requireSession(r)
		if !ok {
			writeError(w, 401, "not authenticated")
			return
		}
		writeJSON(w, 200, map[string]string{"email": email})
	})

	mux.HandleFunc("POST /items", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireSession(r); !ok {
			writeError(w, 401, "not authenticated")
			return
		}
		body, err := readJSONBody(r)
		if err != nil {
			writeError(w, 400, "invalid json")
			return
		}
		name, _ := body["name"].(string)
		if name == "" {
			writeError(w, 400, "name required")
			return
		}
		item := Item{ID: randomID(), Name: name}

		itemsMu.Lock()
		items := readItems(dataFile)
		items = append(items, item)
		err = writeItems(dataFile, items)
		itemsMu.Unlock()
		if err != nil {
			writeError(w, 500, "write failed")
			return
		}
		writeJSON(w, 201, item)
	})

	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireSession(r); !ok {
			writeError(w, 401, "not authenticated")
			return
		}
		id := r.PathValue("id")
		itemsMu.Lock()
		items := readItems(dataFile)
		itemsMu.Unlock()
		for _, item := range items {
			if item.ID == id {
				writeJSON(w, 200, item)
				return
			}
		}
		writeError(w, 404, "not found")
	})

	mux.HandleFunc("POST /upload", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireSession(r); !ok {
			writeError(w, 401, "not authenticated")
			return
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			writeError(w, 400, "file required")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, 400, "file required")
			return
		}
		defer file.Close()

		filename := fmt.Sprintf("%s-%s", randomID(), filepath.Base(header.Filename))
		dst, err := os.Create(filepath.Join(uploadDir, filename)) // FIXED: uploadDir is a shared path, not local-only
		if err != nil {
			writeError(w, 500, "write failed")
			return
		}
		defer dst.Close()
		if _, err := io.Copy(dst, file); err != nil {
			writeError(w, 500, "write failed")
			return
		}
		writeJSON(w, 201, map[string]string{"filename": filename})
	})

	mux.HandleFunc("GET /uploads/{filename}", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireSession(r); !ok {
			writeError(w, 401, "not authenticated")
			return
		}
		safeName := filepath.Base(r.PathValue("filename"))
		path := filepath.Join(uploadDir, safeName)
		if _, err := os.Stat(path); err != nil {
			writeError(w, 404, "not found")
			return
		}
		http.ServeFile(w, r, path)
	})

	log.Printf("fixed-go listening on %s", port)
	// This machine only: ":"+port would listen on every network interface,
	// which is what makes Windows Firewall ask whether to let the network in.
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, mux))
}
