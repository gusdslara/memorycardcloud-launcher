# Use a specific version of golang based on alpine for small size
FROM golang:1.24-alpine

# Set working directory
WORKDIR /app

    # Install git and curl, then install air via binary script to avoid Go version mismatch
    RUN apk add --no-cache git curl && \
        curl -sSfL https://raw.githubusercontent.com/air-verse/air/master/install.sh | sh -s -- -b $(go env GOPATH)/bin

# Copy the rest of the application (including go.mod)
COPY . .

# regenerate go.sum to match the manually edited go.mod
RUN go mod tidy

# Expose port
EXPOSE 8000

# Command to run the application with air for hot reload
# Command to run the application directly (bypassing air for debugging)
CMD ["go", "run", "main.go"]
