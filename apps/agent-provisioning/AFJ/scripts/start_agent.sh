#!/bin/bash

START_TIME=$(date +%s)

AGENCY=$1
EXTERNAL_IP=$2
WALLET_NAME=$3
WALLET_PASSWORD=$4
RANDOM_SEED=$5
WEBHOOK_HOST=$6
WALLET_STORAGE_HOST=$7
WALLET_STORAGE_PORT=$8
WALLET_STORAGE_USER=$9
WALLET_STORAGE_PASSWORD=${10}
CONTAINER_NAME=${11}
PROTOCOL=${12}
TENANT=${13}
AFJ_VERSION=${14}
INDY_LEDGER=${15}
INBOUND_ENDPOINT=${16}
SCHEMA_FILE_SERVER_URL=${17}

ADMIN_PORT_FILE="$PWD/apps/agent-provisioning/AFJ/port-file/last-admin-port.txt"
INBOUND_PORT_FILE="$PWD/apps/agent-provisioning/AFJ/port-file/last-inbound-port.txt"
ADMIN_PORT=8001
INBOUND_PORT=9001

increment_port() {
  local port="$1"
  local lower_limit="$2"

  while [ "$port" -le "$lower_limit" ]; do
    port=$((port + 1)) # Increment the port using arithmetic expansion
  done

  echo "$port"
}

# Check if admin port file exists and if not, create and initialize it
if [ ! -e "$ADMIN_PORT_FILE" ]; then
  echo "$ADMIN_PORT" >"$ADMIN_PORT_FILE"
fi

# Read the last used admin port number from the file
last_used_admin_port=$(cat "$ADMIN_PORT_FILE")
echo "Last used admin port: $last_used_admin_port"

# Increment the admin port number starting from the last used port
last_used_admin_port=$(increment_port "$last_used_admin_port" "$last_used_admin_port")

# Save the updated admin port number back to the file and update the global variable
echo "$last_used_admin_port" >"$ADMIN_PORT_FILE"
ADMIN_PORT="$last_used_admin_port"

# Check if inbound port file exists and if not, create and initialize it
if [ ! -e "$INBOUND_PORT_FILE" ]; then
  echo "$INBOUND_PORT" >"$INBOUND_PORT_FILE"
fi

# Read the last used inbound port number from the file
last_used_inbound_port=$(cat "$INBOUND_PORT_FILE")
echo "Last used inbound port: $last_used_inbound_port"

# Increment the inbound port number starting from the last used port
last_used_inbound_port=$(increment_port "$last_used_inbound_port" "$last_used_inbound_port")

# Save the updated inbound port number back to the file and update the global variable
echo "$last_used_inbound_port" >"$INBOUND_PORT_FILE"
INBOUND_PORT="$last_used_inbound_port"

echo "Last used admin port: $ADMIN_PORT"
echo "Last used inbound port: $INBOUND_PORT"

echo "AGENT SPIN-UP STARTED"

if [ -d "${PWD}/apps/agent-provisioning/AFJ/endpoints" ]; then
  echo "Endpoints directory exists."
else
  echo "Error: Endpoints directory does not exists."
  mkdir ${PWD}/apps/agent-provisioning/AFJ/endpoints
fi

if [ -d "${PWD}/apps/agent-provisioning/AFJ/agent-config" ]; then
  echo "Endpoints directory exists."
else
  echo "Error: Endpoints directory does not exists."
  mkdir ${PWD}/apps/agent-provisioning/AFJ/agent-config
fi

if [ -d "${PWD}/apps/agent-provisioning/AFJ/token" ]; then
  echo "token directory exists."
else
  echo "Error: token directory does not exists."
  mkdir ${PWD}/apps/agent-provisioning/AFJ/token
fi

# Define a regular expression pattern for IP address
IP_REGEX="^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$"

# Check if INBOUND_ENDPOINT is a domain or IP address
if [[ $INBOUND_ENDPOINT =~ ^https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
  echo "INBOUND_ENDPOINT is a domain: $INBOUND_ENDPOINT"
  # Extracting the domain name without the protocol
  AGENT_ENDPOINT=$(echo "$INBOUND_ENDPOINT" | sed 's/^https\?:\/\///')
else
  # Check if the input is an IP address
  if [[ $INBOUND_ENDPOINT =~ $IP_REGEX ]]; then
    echo "INBOUND_ENDPOINT is an IP address: $INBOUND_ENDPOINT"
    # Adding the protocol to the IP address
    AGENT_ENDPOINT="${PROTOCOL}://${INBOUND_ENDPOINT}:${INBOUND_PORT}"
  else
    echo "Invalid input for INBOUND_ENDPOINT: $INBOUND_ENDPOINT"
  fi
fi

echo "-----$AGENT_ENDPOINT----"
CONFIG_FILE="${PWD}/apps/agent-provisioning/AFJ/agent-config/${AGENCY}_${CONTAINER_NAME}.json"

# Check if the file exists
if [ -f "$CONFIG_FILE" ]; then
  # If it exists, remove the file
  rm "$CONFIG_FILE"
fi

cat <<EOF >${CONFIG_FILE}
{
  "label": "${AGENCY}_${CONTAINER_NAME}",
  "walletId": "$WALLET_NAME",
  "walletKey": "$WALLET_PASSWORD",
  "walletType": "postgres",
  "walletUrl": "$WALLET_STORAGE_HOST:$WALLET_STORAGE_PORT",
  "walletAccount": "$WALLET_STORAGE_USER",
  "walletPassword": "$WALLET_STORAGE_PASSWORD",
  "walletAdminAccount": "$WALLET_STORAGE_USER",
  "walletAdminPassword": "$WALLET_STORAGE_PASSWORD",
  "walletScheme": "DatabasePerWallet",
  "indyLedger": $INDY_LEDGER,
  "endpoint": [
    "$AGENT_ENDPOINT"
  ],
  "autoAcceptConnections": true,
  "autoAcceptCredentials": "contentApproved",
  "autoAcceptProofs": "contentApproved",
  "logLevel": 2,
  "inboundTransport": [
    {
      "transport": "$PROTOCOL",
      "port": $INBOUND_PORT
    }
  ],
  "outboundTransport": [
    "$PROTOCOL"
  ],
  "webhookUrl": "$WEBHOOK_HOST/wh/$AGENCY",
  "adminPort": $ADMIN_PORT,
  "tenancy": $TENANT,
  "schemaFileServerURL": "$SCHEMA_FILE_SERVER_URL"
}
EOF

FILE_NAME="docker-compose_${AGENCY}_${CONTAINER_NAME}.yaml"

DOCKER_COMPOSE="${PWD}/apps/agent-provisioning/AFJ/${FILE_NAME}"

# Check if the file exists
if [ -f "$DOCKER_COMPOSE" ]; then
  # If it exists, remove the file
  rm "$DOCKER_COMPOSE"
fi
cat <<EOF >${DOCKER_COMPOSE}
version: '3'

services:
  agent:
    image: $AFJ_VERSION

    container_name: ${AGENCY}_${CONTAINER_NAME}
    restart: always
    environment:
      AFJ_REST_LOG_LEVEL: 1
    ports:
     - ${INBOUND_PORT}:${INBOUND_PORT}
     - ${ADMIN_PORT}:${ADMIN_PORT}
    env_file:
      - ../../../agent.env
   
    volumes: 
      - ./agent-config/${AGENCY}_${CONTAINER_NAME}.json:/config.json   
      
    command: --auto-accept-connections --config /config.json
      
volumes:
  pgdata:
  agent-indy_client:
  agent-tmp:
EOF

if [ $? -eq 0 ]; then
  cd apps/agent-provisioning/AFJ
  echo "docker-compose generated successfully!"
  echo "================="
  echo "spinning up the container"
  echo "================="
  echo "container-name::::::${CONTAINER_NAME}"
  echo "file-name::::::$FILE_NAME"

  # Convert to lowercase and replace hyphens with underscores
  PROJECT_NAME=$(echo "${AGENCY}_${CONTAINER_NAME}" | tr '[:upper:]' '[:lower:]' | tr '-' '_')

  docker rm -f "${PROJECT_NAME}" || true

  docker compose -f $FILE_NAME --project-name "${PROJECT_NAME}" up -d
  if [ $? -eq 0 ]; then

    n=0
    until [ "$n" -ge 6 ]; do
      if netstat -tln | grep ${ADMIN_PORT} >/dev/null; then

        AGENTURL="http://${EXTERNAL_IP}:${ADMIN_PORT}/agent"
        agentResponse=$(curl -s -o /dev/null -w "%{http_code}" $AGENTURL)

        if [ "$agentResponse" = "200" ]; then
          echo "Agent is running" && break
        else
          echo "Agent is not running"
          n=$((n + 1))
          sleep 10
        fi
      else
        echo "No response from agent"
        n=$((n + 1))
        sleep 10
      fi
    done

    echo "Creating agent config"
    # Capture the logs from the container
    container_logs=$(docker logs $(docker ps -q --filter "name=${AGENCY}_${CONTAINER_NAME}"))

    # Extract the token from the logs using sed
    token=$(echo "$container_logs" | sed -nE 's/.*API Token: ([^ ]+).*/\1/p')

    # Print the extracted token
    echo "Token: $token"

    ENDPOINT="${PWD}/endpoints/${AGENCY}_${CONTAINER_NAME}.json"

    # Check if the file exists
    if [ -f "$ENDPOINT" ]; then
      # If it exists, remove the file
      rm "$ENDPOINT"
    fi
    cat <<EOF >${ENDPOINT}
    {
        "CONTROLLER_ENDPOINT":"${EXTERNAL_IP}:${ADMIN_PORT}"
    }
EOF

    cat <<EOF >${PWD}/token/${AGENCY}_${CONTAINER_NAME}.json
    {
        "token" : "$token"
    }
EOF
    echo "Agent config created"
  else
    echo "==============="
    echo "ERROR : Failed to spin up the agent!"
    echo "===============" && exit 125
  fi
else
  echo "ERROR : Failed to execute!" && exit 125
fi

echo "Total time elapsed: $(date -ud "@$(($(date +%s) - $START_TIME))" +%T) (HH:MM:SS)"
