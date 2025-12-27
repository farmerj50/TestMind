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
  }
}
