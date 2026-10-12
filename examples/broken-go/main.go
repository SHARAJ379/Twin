// A minimal net/http app, deliberately broken the way a vibe-coded app
// commonly is: it works perfectly as one process on localhost, and silently
// loses data the moment more than one instance is running.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

const uploadDir = "uploads" // BROKEN: relative to cwd, lands on this instance's own local disk only

// BROKEN: both live only in this process's memory. A second instance (or a
// restart of this one) starts with these empty - that's the bug Twin finds.
var sessions = make(map[string]string) // sessionId -> email
var items []Item

type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
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

func requireSession(r *http.Request) (string, bool) {
	cookie, err := r.Cookie("sid")
	if err != nil {
		return "", false
	}
	email, ok := sessions[cookie.Value]
	return email, ok
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
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
		sid := randomID()
		sessions[sid] = email
		http.SetCookie(w, &http.Cookie{Name: "sid", Value: sid, HttpOnly: true, Path: "/"})
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
		items = append(items, item)
		writeJSON(w, 201, item)
	})

	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireSession(r); !ok {
			writeError(w, 401, "not authenticated")
			return
		}
		id := r.PathValue("id")
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
		dst, err := os.Create(filepath.Join(uploadDir, filename)) // BROKEN: os.Create to a non-env-configured path
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
		safeName := filepath.Base(r.PathValue("filename")) // no path traversal, even in a broken demo app
		path := filepath.Join(uploadDir, safeName)
		if _, err := os.Stat(path); err != nil {
			writeError(w, 404, "not found")
			return
		}
		http.ServeFile(w, r, path)
	})

	log.Printf("broken-go listening on %s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
