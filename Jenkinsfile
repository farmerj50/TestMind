pipeline {
  agent any
  parameters {
    string(name: 'DOCKER_NAMESPACE', defaultValue: 'your-org', description: 'Container registry namespace (e.g., GHCR user/org)')
  }
  environment {
    NODE_VERSION = '20'
    DOCKER_REGISTRY = 'ghcr.io'
    IMAGE_NAME = "${DOCKER_REGISTRY}/${params.DOCKER_NAMESPACE}/testmind-api"
    IMAGE_TAG = "${IMAGE_NAME}:${env.BUILD_NUMBER ?: 'latest'}"
    RAILWAY_SERVICE_ID = credentials('railway-service-id')
    // TESTMIND_API_TOKEN and TM_PROJECT_ID injected from Jenkins container env — no manual credential setup
  }

  stages {
    stage('Checkout & Setup') {
      steps {
        checkout scm
        sh 'corepack enable'
        sh 'corepack pnpm env use --global 9'
      }
    }
    stage('Install Dependencies') {
      steps {
        sh 'pnpm install --frozen-lockfile'
      }
    }
    stage('Lint & Test') {
      steps {
        sh 'pnpm --filter testmind-web lint'
        sh 'pnpm -r test'
      }
    }
    stage('Build Backend') {
      steps {
        sh 'pnpm --filter api build'
      }
    }
    stage('Build & Push Docker Image') {
      environment {
        DOCKER_REGISTRY = 'ghcr.io'
      }
      steps {
        withCredentials([usernamePassword(credentialsId: 'docker-registry', usernameVariable: 'DOCKER_USERNAME', passwordVariable: 'DOCKER_PASSWORD')]) {
          sh '''
            echo "$DOCKER_PASSWORD" | docker login $DOCKER_REGISTRY -u "$DOCKER_USERNAME" --password-stdin
            docker build -f Dockerfile -t "$IMAGE_TAG" .
            docker push "$IMAGE_TAG"
          '''
        }
      }
    }
    stage('Deploy to Railway') {
      steps {
        withCredentials([string(credentialsId: 'railway-api-key', variable: 'RAILWAY_API_KEY')]) {
          sh '''
            npm install -g @railway/cli
            railway login --apiKey "$RAILWAY_API_KEY"
            railway service deploy "$RAILWAY_SERVICE_ID" --image "$IMAGE_TAG"
          '''
        }
      }
    }
    stage('Trigger TestMind QA') {
      steps {
        sh '''
          set -e
          RESPONSE=$(curl -s -o /tmp/tm_response.json -w "%{http_code}" \
            -X POST http://host.docker.internal:8787/jenkins/run \
            -H "Authorization: Bearer ${TESTMIND_API_TOKEN}" \
            -H "Content-Type: application/json" \
            -H "X-Request-ID: jenkins-${BUILD_NUMBER}" \
            -d "{\"workflow\":\"qa-execute\",\"environment\":\"qa\",\"branch\":\"${GIT_BRANCH}\"}")
          cat /tmp/tm_response.json
          echo ""
          echo "HTTP $RESPONSE"
          [ "$RESPONSE" = "202" ] || [ "$RESPONSE" = "409" ] || exit 1
          JOB_ID=$(grep -o '"jobId":"[^"]*"' /tmp/tm_response.json | cut -d'"' -f4)
          echo "TestMind job: $JOB_ID"
          echo "$JOB_ID" > /tmp/tm_job_id.txt
        '''
      }
    }
    stage('Wait for TestMind Results') {
      steps {
        sh '''
          set -e
          JOB_ID=$(cat /tmp/tm_job_id.txt)
          MAX_WAIT=1200
          WAITED=0
          STATUS="queued"

          echo "Polling TestMind job $JOB_ID ..."
          while [ "$STATUS" = "queued" ] || [ "$STATUS" = "running" ] || [ "$STATUS" = "blocked" ]; do
            if [ "$WAITED" -ge "$MAX_WAIT" ]; then
              echo "TIMEOUT: TestMind did not complete within ${MAX_WAIT}s"
              exit 1
            fi
            sleep 15
            WAITED=$((WAITED + 15))
            STATUS_JSON=$(curl -s \
              "http://host.docker.internal:8787/jenkins/status/${JOB_ID}" \
              -H "Authorization: Bearer ${TESTMIND_API_TOKEN}")
            STATUS=$(echo "$STATUS_JSON" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
            PASSED=$(echo "$STATUS_JSON" | grep -o '"passed":[0-9]*' | cut -d':' -f2)
            FAILED=$(echo "$STATUS_JSON" | grep -o '"failed":[0-9]*' | cut -d':' -f2)
            echo "[${WAITED}s] status=${STATUS} passed=${PASSED:-0} failed=${FAILED:-0}"
          done

          PASSED=$(echo "$STATUS_JSON" | grep -o '"passed":[0-9]*' | cut -d':' -f2)
          FAILED=$(echo "$STATUS_JSON" | grep -o '"failed":[0-9]*' | cut -d':' -f2)
          TOTAL=$(echo "$STATUS_JSON" | grep -o '"total":[0-9]*' | cut -d':' -f2)
          RUN_URL=$(echo "$STATUS_JSON" | grep -o '"runUrl":"[^"]*"' | head -1 | cut -d'"' -f4)
          echo "=== TestMind QA Results: status=${STATUS} passed=${PASSED:-0} failed=${FAILED:-0} total=${TOTAL:-0} ==="
          [ -n "$RUN_URL" ] && echo "Results: $RUN_URL"
          [ "$STATUS" = "succeeded" ] || { echo "Tests FAILED"; exit 1; }
        '''
      }
    }
  }
}
